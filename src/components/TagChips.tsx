import Link from "next/link";

export function TagChips({ tags, active }: { tags: { tag: string; n: number }[]; active: string | null }) {
  if (tags.length === 0) return null;
  return (
    <nav aria-label="Filter by tag" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      {tags.map(({ tag, n }) => {
        const on = tag === active;
        return (
          <Link
            key={tag}
            href={on ? "/list" : `/list?tag=${encodeURIComponent(tag)}`}
            aria-current={on ? "true" : undefined}
            className={`flex h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-sm ${
              on ? "border-accent bg-accent text-white" : "border-border bg-surface text-muted hover:border-accent"
            }`}
          >
            {tag}
            <span className={on ? "text-white/70" : "text-muted/70"}>{n}</span>
          </Link>
        );
      })}
    </nav>
  );
}
