"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { embedLogs } from "@/lib/embeddings";
import { normalizeUrl, parseTags } from "@/lib/format";
import { searchLogIds } from "@/lib/queries";
import { IMAGE_BUCKET } from "@/lib/types";

export type LogInput = {
  caption: string;
  tags: string;
  sourceUrl: string;
  imagePath: string | null;
};

export type ActionResult = { ok: true; id: string; embedded: boolean } | { ok: false; error: string };

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return { supabase, user };
}

function validate(input: LogInput, userId: string) {
  const caption = input.caption.trim();
  if (!caption) return { error: "Write a one-line caption for this log." } as const;
  if (caption.length > 1000) return { error: "Keep the caption under 1000 characters." } as const;
  if (input.sourceUrl.trim() && !normalizeUrl(input.sourceUrl)) {
    return { error: "That link doesn't look like a valid URL." } as const;
  }
  // Images must be uploaded into the caller's own folder.
  if (input.imagePath && !input.imagePath.startsWith(`${userId}/`)) {
    return { error: "Invalid image." } as const;
  }
  return {
    caption,
    tags: parseTags(input.tags),
    source_url: normalizeUrl(input.sourceUrl),
    image_path: input.imagePath,
  } as const;
}

// Insert first, embed second: a failed embedding never loses the log.
// Unembedded logs are retried from the UI or by the daily cron.
async function tryEmbed(
  supabase: Awaited<ReturnType<typeof createClient>>,
  log: { id: string; caption: string; tags: string[] },
) {
  try {
    return (await embedLogs(supabase, [log])) === 1;
  } catch (err) {
    console.error("Embedding failed; will retry later", err);
    return false;
  }
}

export async function createLog(input: LogInput): Promise<ActionResult> {
  const { supabase, user } = await requireUser();
  const values = validate(input, user.id);
  if ("error" in values) return { ok: false, error: values.error! };

  const { data, error } = await supabase.from("logs").insert(values).select("id").single();
  if (error) return { ok: false, error: error.message };

  const embedded = await tryEmbed(supabase, { id: data.id, ...values });
  revalidatePath("/");
  return { ok: true, id: data.id, embedded };
}

export async function updateLog(id: string, input: LogInput): Promise<ActionResult> {
  const { supabase, user } = await requireUser();
  const values = validate(input, user.id);
  if ("error" in values) return { ok: false, error: values.error! };

  const { data: existing } = await supabase
    .from("logs")
    .select("image_path")
    .eq("id", id)
    .single();

  // Clear the embedding so a failed re-embed is picked up by the backfill,
  // and the map position so the log is re-placed by its new meaning.
  const { error } = await supabase
    .from("logs")
    .update({ ...values, embedding: null, embedding_model: null, x: null, y: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (existing?.image_path && existing.image_path !== values.image_path) {
    await supabase.storage.from(IMAGE_BUCKET).remove([existing.image_path]);
  }

  const embedded = await tryEmbed(supabase, { id, ...values });
  revalidatePath("/");
  revalidatePath(`/log/${id}`);
  return { ok: true, id, embedded };
}

export async function retryEmbedding(id: string): Promise<boolean> {
  const { supabase } = await requireUser();
  const { data } = await supabase.from("logs").select("id, caption, tags").eq("id", id).single();
  if (!data) return false;
  const embedded = await tryEmbed(supabase, data);
  revalidatePath("/");
  revalidatePath(`/log/${id}`);
  return embedded;
}

export async function deleteLog(id: string) {
  const { supabase } = await requireUser();
  const { data } = await supabase.from("logs").select("image_path").eq("id", id).single();
  await supabase.from("logs").delete().eq("id", id);
  if (data?.image_path) {
    await supabase.storage.from(IMAGE_BUCKET).remove([data.image_path]);
  }
  revalidatePath("/");
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// Map: persist a layout snapshot. Chunked to stay under the action body limit.
export async function savePositions(positions: { id: string; x: number; y: number }[]) {
  const { supabase } = await requireUser();
  for (let i = 0; i < positions.length; i += 2000) {
    const { error } = await supabase.rpc("save_positions", { positions: positions.slice(i, i + 2000) });
    if (error) throw new Error(error.message);
  }
}

export async function searchMap(query: string): Promise<string[]> {
  await requireUser();
  const q = query.trim();
  return q ? searchLogIds(q) : [];
}
