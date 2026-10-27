import { createHash } from "node:crypto";
import { after } from "next/server";
import { embedLogs } from "@/lib/embeddings";
import { fetchLinkTitle } from "@/lib/link-title";
import { normalizeUrl, parseTags } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";

// Log a thought without opening the app: for an iOS Shortcut, the Share
// Sheet or Siri. Authenticated by the personal token created in the menu.
//   POST /api/capture  Authorization: Bearer <token>
//   { "text": "...", "tags": "a, b", "url": "https://..." }
const MAX_BODY = 16 * 1024;
const PER_MINUTE = 10;

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
    return Response.json({ ok: false, error: "Too large" }, { status: 413 });
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length < 32) return Response.json({ ok: false, error: "Missing token" }, { status: 401 });

  const supabase = createAdminClient();
  const hash = createHash("sha256").update(token).digest("hex");
  const { data: owner } = await supabase.from("brain_settings").select("user_id").eq("capture_token_hash", hash).maybeSingle();
  if (!owner) return Response.json({ ok: false, error: "Invalid token" }, { status: 401 });

  // A leaked token (e.g. in a shared Shortcut) must not flood the brain or
  // burn the embedding quota.
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase
    .from("logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", owner.user_id)
    .gte("created_at", since);
  if ((count ?? 0) >= PER_MINUTE) return Response.json({ ok: false, error: "Slow down" }, { status: 429 });

  let body: { text?: unknown; tags?: unknown; url?: unknown };
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return Response.json({ ok: false, error: "Too large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: "Send JSON" }, { status: 400 });
  }
  const caption = typeof body.text === "string" ? body.text.trim() : "";
  if (!caption) return Response.json({ ok: false, error: "Nothing to log" }, { status: 400 });
  if (caption.length > 1000) return Response.json({ ok: false, error: "Keep it under 1000 characters" }, { status: 400 });

  // Shortcuts may send tags as text ("a, b") or as a list.
  const rawTags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string").join(",") : body.tags;
  const sourceUrl = typeof body.url === "string" && body.url.trim() ? normalizeUrl(body.url) : null;
  const values = {
    user_id: owner.user_id,
    caption,
    tags: typeof rawTags === "string" ? parseTags(rawTags) : [],
    source_url: sourceUrl,
  };
  const { data, error } = await supabase.from("logs").insert(values).select("id").single();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  // Respond right away; connecting it to the brain happens afterwards.
  after(async () => {
    try {
      await embedLogs(supabase, [{ id: data.id, caption: values.caption, tags: values.tags }]);
    } catch (err) {
      console.error("Capture embedding failed; the app or daily cron will retry", err);
    }
    if (sourceUrl) {
      const title = await fetchLinkTitle(sourceUrl);
      if (title) await supabase.from("logs").update({ source_title: title }).eq("id", data.id);
    }
  });
  const badUrl = typeof body.url === "string" && body.url.trim() && !sourceUrl;
  return Response.json({ ok: true, id: data.id, ...(badUrl ? { warning: "Ignored an invalid url" } : {}) });
}
