import { createHash } from "node:crypto";
import { after } from "next/server";
import { embedLogs } from "@/lib/embeddings";
import { normalizeUrl, parseTags } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";

// Log a thought without opening the app: for an iOS Shortcut, the Share
// Sheet or Siri. Authenticated by the personal token created in the menu.
//   POST /api/capture  Authorization: Bearer <token>
//   { "text": "...", "tags": "a, b", "url": "https://..." }
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length < 32) return Response.json({ ok: false, error: "Missing token" }, { status: 401 });

  const supabase = createAdminClient();
  const hash = createHash("sha256").update(token).digest("hex");
  const { data: owner } = await supabase.from("brain_settings").select("user_id").eq("capture_token_hash", hash).maybeSingle();
  if (!owner) return Response.json({ ok: false, error: "Invalid token" }, { status: 401 });

  let body: { text?: unknown; tags?: unknown; url?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Send JSON" }, { status: 400 });
  }
  const caption = typeof body.text === "string" ? body.text.trim() : "";
  if (!caption) return Response.json({ ok: false, error: "Nothing to log" }, { status: 400 });
  if (caption.length > 1000) return Response.json({ ok: false, error: "Keep it under 1000 characters" }, { status: 400 });

  const values = {
    user_id: owner.user_id,
    caption,
    tags: typeof body.tags === "string" ? parseTags(body.tags) : [],
    source_url: typeof body.url === "string" ? normalizeUrl(body.url) : null,
  };
  const { data, error } = await supabase.from("logs").insert(values).select("id").single();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  // Respond right away; connecting it to the brain happens afterwards.
  after(async () => {
    try {
      await embedLogs(supabase, [{ id: data.id, caption: values.caption, tags: values.tags }]);
    } catch (err) {
      console.error("Capture embedding failed; the daily cron will retry", err);
    }
  });
  return Response.json({ ok: true, id: data.id });
}
