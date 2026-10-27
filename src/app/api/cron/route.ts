import { createAdminClient } from "@/lib/supabase/admin";
import { embedLogs } from "@/lib/embeddings";
import { IMAGE_BUCKET } from "@/lib/types";

// Daily (vercel.json). Querying the DB keeps the free Supabase project from
// pausing; it also backfills logs whose embedding failed on save and rebuilds
// the map's neighbour lists (fixing similarities that went stale after edits).
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createAdminClient();

  // Permanently remove logs deleted more than a week ago (and their images).
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: expired } = await supabase.from("logs").select("id, image_path").lt("deleted_at", cutoff);
  if (expired?.length) {
    const images = expired.map((l) => l.image_path).filter((p): p is string => !!p);
    if (images.length) await supabase.storage.from(IMAGE_BUCKET).remove(images);
    await supabase.from("logs").delete().in("id", expired.map((l) => l.id));
  }

  const { data, error } = await supabase
    .from("logs")
    .select("id, caption, tags")
    .is("embedding", null)
    .is("deleted_at", null)
    // Small batch: Voyage's free tier allows 10K tokens/min without a card.
    .limit(200);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let embedded = 0;
  let embedError: string | null = null;
  try {
    // One batched Voyage request, so the free-tier 3 RPM limit isn't an issue.
    embedded = await embedLogs(supabase, data);
  } catch (err) {
    embedError = err instanceof Error ? err.message : String(err);
  }

  const { data: rebuilt, error: rebuildError } = await supabase.rpc("rebuild_all_neighbors");

  return Response.json({
    purged: expired?.length ?? 0,
    pending: data.length,
    embedded,
    embedError,
    neighborsRebuilt: rebuilt,
    rebuildError: rebuildError?.message ?? null,
  });
}
