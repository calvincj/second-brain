import Link from "next/link";
import { Suspense } from "react";
import { signOut } from "@/app/actions";
import { LogCard } from "@/components/LogCard";
import { LogForm } from "@/components/LogForm";
import { SearchBar } from "@/components/SearchBar";
import { FormSkeleton, ListSkeleton } from "@/components/Skeletons";
import { getRecentLogs, searchLogs } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">🧠 2nd Brain</h1>
        <div className="flex items-center gap-1 text-sm text-muted">
          <Link href="/map" className="rounded-lg px-3 py-2 font-medium text-accent hover:bg-surface-2">
            Map
          </Link>
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

async function Results({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const logs = query ? await searchLogs(query) : await getRecentLogs();

  return (
    <div className="space-y-2">
      <p className="px-1 text-xs uppercase tracking-wide text-muted">
        {query ? `${logs.length} result${logs.length === 1 ? "" : "s"} for "${query}"` : "Recent"}
      </p>
      {logs.map((log) => (
        <LogCard key={log.id} log={log} showSimilarity={!!query} />
      ))}
      {logs.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
          {query ? "Nothing matches that yet." : "No logs yet. Write down the last interesting thing you learned."}
        </p>
      )}
    </div>
  );
}
