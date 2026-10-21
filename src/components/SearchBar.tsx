"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export function SearchBar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("q") ?? "";
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();

  // Debounce typing into the URL; the server page does the search.
  useEffect(() => {
    if (value.trim() === current) return;
    const timer = setTimeout(() => {
      const q = value.trim();
      startTransition(() => router.replace(q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname));
    }, 350);
    return () => clearTimeout(timer);
  }, [value, current, pathname, router]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">⌕</span>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by term or idea…"
        className="h-11 w-full rounded-xl border border-border bg-surface pl-9 pr-10 outline-none focus:border-accent"
      />
      {pending && (
        <span className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      )}
    </div>
  );
}
