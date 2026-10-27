"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ActionResult } from "@/app/actions";
import { LogForm } from "@/components/LogForm";

type Saved = Extract<ActionResult, { ok: true }>;

// The fast lane: just the form, no 3D. Opened from the home screen, an iOS
// Shortcut ("/capture?text=…&url=…") or the Share Sheet.
export function CaptureView({ userId, text, url }: { userId: string; text: string; url: string }) {
  const router = useRouter();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [round, setRound] = useState(0);

  return (
    <div className="mx-auto max-w-lg px-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]" />
          New thought
        </h1>
        <Link href="/" className="rounded-full border border-border px-4 py-2 text-sm text-muted">
          Brain →
        </Link>
      </div>

      {saved && (
        <div className="brain-fade-in mb-4 rounded-2xl border border-accent/40 bg-surface px-4 py-3 text-sm">
          ✦ Saved.{" "}
          {saved.embedded
            ? saved.neighbors.length
              ? `Connected to ${saved.neighbors.length} thought${saved.neighbors.length === 1 ? "" : "s"} in your brain.`
              : "A new idea, unlike anything else in your brain yet."
            : "It'll connect once it's processed."}
        </div>
      )}

      <LogForm
        key={round}
        userId={userId}
        prefill={round === 0 ? text : undefined}
        prefillUrl={round === 0 ? url : undefined}
        autoFocus
        onSaved={(r) => {
          setSaved(r);
          setRound((n) => n + 1);
          // Drop ?text= so a reload (iOS restoring the tab) can't save it twice.
          router.replace("/capture");
        }}
      />
    </div>
  );
}
