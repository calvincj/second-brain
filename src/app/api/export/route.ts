import { fetchAll } from "@/lib/fetch-all";
import { createClient } from "@/lib/supabase/server";
import { LOG_COLUMNS, type Log } from "@/lib/types";

// Download all logs as JSON (default) or Markdown (?format=md). Your backup.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const logs = await fetchAll<Log>((from, to) =>
    supabase
      .from("logs")
      .select(LOG_COLUMNS)
      .order("created_at", { ascending: true })
      .order("id")
      .range(from, to),
  );

  const date = new Date().toISOString().slice(0, 10);
  const format = new URL(request.url).searchParams.get("format");

  if (format === "md") {
    const body = logs
      .map((l) => {
        const meta = [
          l.tags.length ? `Tags: ${l.tags.join(", ")}` : null,
          l.source_url ? `Source: ${l.source_url}` : null,
          l.image_path ? `Image: ${l.image_path}` : null,
          `Logged: ${l.created_at}`,
        ].filter(Boolean);
        return `- ${l.caption.replace(/\n/g, "\n  ")}\n${meta.map((m) => `  - ${m}`).join("\n")}`;
      })
      .join("\n");
    return new Response(`# 2nd Brain export (${date})\n\n${body}\n`, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="second-brain-${date}.md"`,
      },
    });
  }

  return new Response(JSON.stringify({ exported_at: new Date().toISOString(), logs }, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="second-brain-${date}.json"`,
    },
  });
}
