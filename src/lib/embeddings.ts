import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const VOYAGE_MODEL = "voyage-3.5-lite";
const DIMENSIONS = 1024;

type InputType = "document" | "query";

// Without a Voyage key in development, fall back to a crude local embedding
// (hashed words + trigrams) so the whole app can run offline. Never in production.
function isMockMode() {
  return !process.env.VOYAGE_API_KEY && process.env.NODE_ENV !== "production";
}

export function embeddingModel() {
  return isMockMode() ? "mock-hash-v1" : VOYAGE_MODEL;
}

// Embeds up to ~1000 texts in one request. Throws on API failure.
export async function embed(texts: string[], inputType: InputType): Promise<number[][]> {
  if (isMockMode()) return texts.map(mockEmbed);

  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: inputType }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function mockEmbed(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const add = (token: string, weight: number) => {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
    v[Math.abs(h) % DIMENSIONS] += weight;
  };
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    add(w, 1);
    for (let i = 0; i + 3 <= w.length; i++) add(`#${w.slice(i, i + 3)}`, 0.3);
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

// The text that represents a log semantically.
export function embeddingText(log: { caption: string; tags: string[] }) {
  return log.tags.length ? `${log.caption}\nTags: ${log.tags.join(", ")}` : log.caption;
}

// Recently embedded queries, per server instance.
const queryCache = new Map<string, number[]>();
const QUERY_CACHE_SIZE = 200;

// Embeds a search query, or returns null so search can fall back to keywords.
// Checks an in-memory cache, then the user's cached queries in the database,
// before spending one of Voyage's (free tier: 3/minute) requests.
export async function embedQuery(query: string, supabase?: SupabaseClient): Promise<number[] | null> {
  const key = query.trim().toLowerCase();
  const model = embeddingModel();
  const memKey = `${model}:${key}`;
  const hit = queryCache.get(memKey);
  if (hit) return hit;

  if (supabase) {
    // Tolerates the cache table not existing yet (migration 0005 not run).
    const { data } = await supabase
      .from("query_embeddings")
      .select("embedding")
      .eq("model", model)
      .eq("query", key)
      .maybeSingle();
    if (data?.embedding) {
      const vector = typeof data.embedding === "string" ? (JSON.parse(data.embedding) as number[]) : (data.embedding as number[]);
      remember(memKey, vector);
      return vector;
    }
  }

  try {
    const [vector] = await embed([key], "query");
    remember(memKey, vector);
    if (supabase) {
      await supabase.from("query_embeddings").insert({ query: key, model, embedding: JSON.stringify(vector) });
    }
    return vector;
  } catch (err) {
    console.error("Query embedding failed", err);
    return null;
  }
}

function remember(key: string, vector: number[]) {
  queryCache.delete(key);
  queryCache.set(key, vector);
  if (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value!);
}

// Embeds the given logs, writes the vectors back and refreshes each log's
// neighbour list for the map. Returns how many succeeded.
export async function embedLogs(
  supabase: SupabaseClient,
  logs: { id: string; caption: string; tags: string[] }[],
): Promise<number> {
  if (logs.length === 0) return 0;
  const vectors = await embed(logs.map(embeddingText), "document");
  const model = embeddingModel();
  let ok = 0;
  for (let i = 0; i < logs.length; i++) {
    const { error } = await supabase
      .from("logs")
      .update({ embedding: JSON.stringify(vectors[i]), embedding_model: model })
      .eq("id", logs[i].id);
    if (error) {
      console.error("Saving embedding failed", logs[i].id, error);
      continue;
    }
    ok++;
    const { error: nError } = await supabase.rpc("refresh_neighbors", { target_id: logs[i].id });
    if (nError) console.error("Refreshing neighbors failed", logs[i].id, nError);
  }
  return ok;
}
