"use client";

import { useState, useTransition } from "react";
import { deleteLog, retryEmbedding } from "@/app/actions";
import { LogForm } from "@/components/LogForm";
import type { LogWithImage } from "@/lib/queries";

export function LogActions({ log, userId }: { log: LogWithImage; userId: string }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [retryFailed, setRetryFailed] = useState(false);

  if (editing) {
    return (
      <LogForm
        userId={userId}
        logId={log.id}
        initial={{
          caption: log.caption,
          tags: log.tags,
          sourceUrl: log.source_url ?? "",
          imagePath: log.image_path,
          imageUrl: log.imageUrl,
        }}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => setEditing(true)}
        className="h-11 rounded-lg border border-border px-4 text-sm hover:bg-surface-2"
      >
        Edit
      </button>
      {!log.embedding_model && (
        <button
          disabled={pending}
          onClick={() =>
            startTransition(async () => setRetryFailed(!(await retryEmbedding(log.id))))
          }
          className="h-11 rounded-lg border border-border px-4 text-sm hover:bg-surface-2 disabled:opacity-60"
        >
          {pending ? "Linking…" : retryFailed ? "Retry failed, try again" : "Link to related"}
        </button>
      )}
      <div className="flex-1" />
      <button
        disabled={pending}
        // No confirm dialog: the list offers Undo (deletes are soft).
        onClick={() => startTransition(() => deleteLog(log.id))}
        className="h-11 rounded-lg px-4 text-sm text-danger hover:bg-surface-2 disabled:opacity-60"
      >
        Delete
      </button>
    </div>
  );
}
