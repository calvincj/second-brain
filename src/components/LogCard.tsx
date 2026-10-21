import Link from "next/link";
import { domainOf, timeAgo } from "@/lib/format";
import type { LogWithImage } from "@/lib/queries";

export function LogCard({ log, showSimilarity = false }: { log: LogWithImage; showSimilarity?: boolean }) {
  return (
    <Link
      href={`/log/${log.id}`}
      className="flex gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-accent"
    >
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words leading-snug">{log.caption}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {log.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">
              {tag}
            </span>
          ))}
          {log.source_url && <span>↗ {domainOf(log.source_url)}</span>}
          <span>{timeAgo(log.created_at)}</span>
          {showSimilarity && log.similarity != null && (
            <span title="Semantic similarity">{Math.round(log.similarity * 100)}% related</span>
          )}
          {!log.embedding_model && <span title="Not linked to related logs yet">· unlinked</span>}
        </div>
      </div>
      {log.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={log.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
      )}
    </Link>
  );
}
