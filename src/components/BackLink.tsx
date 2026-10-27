"use client";

import { useRouter } from "next/navigation";

// Goes back to wherever you came from (brain or list); home if opened directly.
export function BackLink({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}
      className={className}
    >
      ← Back
    </button>
  );
}
