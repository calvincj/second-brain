import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LogActions } from "@/components/LogActions";
import { LogCard } from "@/components/LogCard";
import { ListSkeleton } from "@/components/Skeletons";
import { domainOf } from "@/lib/format";
import { getLog, getRelatedLogs } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export default function LogPage({ params }: PageProps<"/log/[id]">) {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))]">
      <Link href="/" className="-ml-2 inline-flex h-11 items-center rounded-lg px-2 text-sm text-muted hover:bg-surface-2">
        ← Back
      </Link>
      <Suspense fallback={<ListSkeleton rows={2} />}>
        <LogDetail params={params} />
      </Suspense>
    </main>
  );
}

async function LogDetail({ params }: Pick<PageProps<"/log/[id]">, "params">) {
  const { id } = await params;
  const log = await getLog(id);
  if (!log) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <article className="mt-2 rounded-2xl border border-border bg-surface p-4">
        <p className="whitespace-pre-wrap break-words text-lg leading-snug">{log.caption}</p>
        {log.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {log.tags.map((tag) => (
              <Link
                key={tag}
                href={`/?q=${encodeURIComponent(tag)}`}
                className="rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent"
              >
                {tag}
              </Link>
            ))}
          </div>
        )}
        {log.source_url && (
          <a
            href={log.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-sm text-accent underline-offset-2 hover:underline"
          >
            ↗ {domainOf(log.source_url)}
          </a>
        )}
        {log.imageUrl && (
          <a href={log.imageUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={log.imageUrl} alt="" className="max-h-[60vh] w-auto rounded-xl border border-border" />
          </a>
        )}
        <p className="mt-3 text-xs text-muted">Logged {new Date(log.created_at).toLocaleString()}</p>
      </article>

      <div className="mt-3">
        <LogActions log={log} userId={user!.id} />
      </div>

      <section className="mt-8 space-y-2">
        <h2 className="px-1 text-xs uppercase tracking-wide text-muted">Related</h2>
        {log.embedding_model ? (
          <Suspense fallback={<ListSkeleton rows={3} />}>
            <Related id={id} />
          </Suspense>
        ) : (
          <p className="px-1 text-sm text-muted">Not linked yet.</p>
        )}
      </section>
    </>
  );
}

async function Related({ id }: { id: string }) {
  const related = await getRelatedLogs(id);
  if (related.length === 0) {
    return <p className="px-1 text-sm text-muted">Nothing related yet. Keep logging.</p>;
  }
  return related.map((r) => <LogCard key={r.id} log={r} showSimilarity />);
}
