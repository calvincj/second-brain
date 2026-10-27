"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { rediscover } from "@/app/actions";
import { timeAgo } from "@/lib/format";
import type { LogWithImage } from "@/lib/queries";

// Resurfaces a random older log, so things you learned come back around.
export function Rediscover({ initial }: { initial: LogWithImage }) {
  const [log, setLog] = useState(initial);
  const [pending, startTransition] = useTransition();

  return (
    <section aria-label="Rediscover" className="rounded-2xl border border-accent/30 bg-accent-soft/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-accent">Rediscover</h2>
        <button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const next = await rediscover(log.id);
              if (next) setLog(next);
            })
          }
          className="-my-2 -mr-2 h-11 rounded-lg px-3 text-sm text-accent disabled:opacity-60"
        >
          {pending ? "…" : "↻ Another"}
        </button>
      </div>
      <Link href={`/log/${log.id}`} className="flex gap-3">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-snug">{log.caption}</p>
        {log.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={log.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
        )}
      </Link>
      <p className="mt-2 text-xs text-muted" suppressHydrationWarning>
        Logged {timeAgo(log.created_at)}
      </p>
    </section>
  );
}
