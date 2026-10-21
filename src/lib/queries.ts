import "server-only";
import { createClient } from "@/lib/supabase/server";
import { embedQuery } from "@/lib/embeddings";
import { fetchAll } from "@/lib/fetch-all";
import { IMAGE_BUCKET, LOG_COLUMNS, type Log, type MapEdge, type MapNode } from "@/lib/types";

export type LogWithImage = Log & { imageUrl: string | null; similarity?: number | null };

type Supabase = Awaited<ReturnType<typeof createClient>>;

// One batched call for all signed image URLs on a page.
async function attachImageUrls(supabase: Supabase, logs: (Log & { similarity?: number | null })[]) {
  const paths = logs.map((l) => l.image_path).filter((p): p is string => !!p);
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from(IMAGE_BUCKET).createSignedUrls(paths, 60 * 60);
    data?.forEach((d) => d.path && d.signedUrl && urls.set(d.path, d.signedUrl));
  }
  return logs.map((l) => ({ ...l, imageUrl: l.image_path ? (urls.get(l.image_path) ?? null) : null }));
}

async function logsByIds(supabase: Supabase, ids: string[], similarity: Map<string, number | null>) {
  if (!ids.length) return [];
  const { data, error } = await supabase.from("logs").select(LOG_COLUMNS).in("id", ids);
  if (error) throw error;
  const byId = new Map((data as Log[]).map((l) => [l.id, l]));
  const ordered = ids.flatMap((id) => {
    const log = byId.get(id);
    return log ? [{ ...log, similarity: similarity.get(id) ?? null }] : [];
  });
  return attachImageUrls(supabase, ordered);
}

export async function getRecentLogs(limit = 100): Promise<LogWithImage[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("logs")
    .select(LOG_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return attachImageUrls(supabase, data as Log[]);
}

export async function searchLogs(query: string): Promise<LogWithImage[]> {
  const supabase = await createClient();
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embedding ? JSON.stringify(embedding) : null,
  });
  if (error) throw error;
  const rows = data as { id: string; similarity: number | null }[];
  return logsByIds(
    supabase,
    rows.map((r) => r.id),
    new Map(rows.map((r) => [r.id, r.similarity])),
  );
}

export async function getLog(id: string): Promise<LogWithImage | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("logs").select(LOG_COLUMNS).eq("id", id).maybeSingle();
  if (!data) return null;
  const [log] = await attachImageUrls(supabase, [data as Log]);
  return log;
}

export async function getRelatedLogs(id: string): Promise<LogWithImage[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("related_logs", { target_id: id });
  if (error) throw error;
  const rows = data as { id: string; similarity: number }[];
  return logsByIds(
    supabase,
    rows.map((r) => r.id),
    new Map(rows.map((r) => [r.id, r.similarity])),
  );
}

// Everything the brain map needs: nodes with saved positions, plus the
// directed neighbour lists. No vectors leave the database.
export async function getMapData(): Promise<{ nodes: MapNode[]; edges: MapEdge[] }> {
  const supabase = await createClient();
  const [logs, neighbors] = await Promise.all([
    fetchAll<{ id: string; caption: string; tags: string[]; x: number | null; y: number | null; embedding_model: string | null }>(
      (from, to) =>
        supabase
          .from("logs")
          .select("id, caption, tags, x, y, embedding_model")
          .order("created_at")
          .order("id")
          .range(from, to),
    ),
    fetchAll<{ log_id: string; neighbor_id: string; similarity: number }>((from, to) =>
      supabase
        .from("log_neighbors")
        .select("log_id, neighbor_id, similarity")
        .order("log_id")
        .order("neighbor_id")
        .range(from, to),
    ),
  ]);
  return {
    nodes: logs.map(({ embedding_model, ...l }) => ({ ...l, embedded: !!embedding_model })),
    edges: neighbors.map((n) => ({ source: n.log_id, target: n.neighbor_id, similarity: n.similarity })),
  };
}

// Search returning only ordered ids (the map already has the nodes).
export async function searchLogIds(query: string): Promise<string[]> {
  const supabase = await createClient();
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embedding ? JSON.stringify(embedding) : null,
    match_count: 20,
  });
  if (error) throw error;
  return (data as { id: string }[]).map((r) => r.id);
}
