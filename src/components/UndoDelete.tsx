"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restoreLog } from "@/app/actions";

// Shown on the list after deleting from a log's page: soft delete makes it undoable.
export function UndoDelete({ id }: { id: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      <span className="text-muted">{failed ? "Couldn't undo that one." : "Thought deleted."}</span>
      {!failed && (
        <button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              if (await restoreLog(id)) router.replace("/list");
              else setFailed(true);
            })
          }
          className="font-medium text-accent disabled:opacity-60"
        >
          Undo
        </button>
      )}
    </div>
  );
}
