import { createAdminClient } from "@/lib/supabase/admin";
import { embedLogs } from "@/lib/embeddings";

// Daily (vercel.json). Querying the DB keeps the free Supabase project from
// pausing; it also backfills logs whose embedding failed on save and rebuilds
// the map's neighbour lists (fixing similarities that went stale after edits).
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("logs")
    .select("id, caption, tags")
    .is("embedding", null)
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
    pending: data.length,
    embedded,
    embedError,
    neighborsRebuilt: rebuilt,
    rebuildError: rebuildError?.message ?? null,
  });
}
