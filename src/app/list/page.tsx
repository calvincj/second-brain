import Link from "next/link";
import { Suspense } from "react";
import { signOut } from "@/app/actions";
import { LogCard } from "@/components/LogCard";
import { LogForm } from "@/components/LogForm";
import { SearchBar } from "@/components/SearchBar";
import { FormSkeleton, ListSkeleton } from "@/components/Skeletons";
import { TagChips } from "@/components/TagChips";
import { UndoDelete } from "@/components/UndoDelete";
import { getRecentLogs, getTagCounts, searchLogs } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "List · 2nd Brain" };

export default function ListPage({ searchParams }: PageProps<"/list">) {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="mb-4 flex items-center justify-between">
        <Link href="/" className="-ml-2 rounded-lg px-2 py-2 text-lg font-semibold tracking-tight hover:bg-surface-2">
          ← 🧠 Brain
        </Link>
        <div className="flex items-center gap-1 text-sm text-muted">
          <a href="/api/export" className="rounded-lg px-3 py-2 hover:bg-surface-2">
            Export
          </a>
          <form action={signOut}>
            <button className="rounded-lg px-3 py-2 hover:bg-surface-2">Sign out</button>
          </form>
        </div>
      </header>

      <Suspense fallback={<FormSkeleton />}>
        <QuickAdd />
      </Suspense>

      <div className="mt-6">
        <Suspense>
          <SearchBar />
        </Suspense>
      </div>

      <section className="mt-4">
        <Suspense fallback={<ListSkeleton />}>
          <Results searchParams={searchParams} />
        </Suspense>
      </section>
    </main>
  );
}

async function QuickAdd() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return <LogForm userId={user!.id} />;
}

function param(value: string | string[] | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

async function Results({ searchParams }: Pick<PageProps<"/list">, "searchParams">) {
  const params = await searchParams;
  const query = param(params.q);
  const tag = param(params.tag);
  const deleted = param(params.deleted);

  const [logs, tags] = await Promise.all([
    query ? searchLogs(query) : getRecentLogs({ tag: tag || undefined }),
    query ? Promise.resolve([]) : getTagCounts(),
  ]);

  const heading = query
    ? `${logs.length} result${logs.length === 1 ? "" : "s"} for "${query}"`
    : tag
      ? `${logs.length} tagged ${tag}`
      : "Recent";

  return (
    <div className="space-y-3">
      {deleted && <UndoDelete key={deleted} id={deleted} />}
      {!query && <TagChips tags={tags} active={tag || null} />}
      <div className="space-y-2">
        <p className="px-1 text-xs uppercase tracking-wide text-muted">{heading}</p>
        {logs.map((log) => (
          <LogCard key={log.id} log={log} />
        ))}
        {logs.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
            {query || tag ? "Nothing matches that yet." : "No logs yet. Write down the last interesting thing you learned."}
          </p>
        )}
      </div>
    </div>
  );
}
