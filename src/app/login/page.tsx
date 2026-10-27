"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";

// Only same-site destinations: resolve it like the browser will (which
// strips tabs/newlines and treats "/\\" as "//") and require our origin.
function safeNext(next: string | null) {
  if (!next || !next.startsWith("/")) return "/";
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

// Email + password: no emails to send (so no custom SMTP), and iOS Keychain
// autofills it inside the home-screen app. Signups are disabled, so only the
// account created in the Supabase dashboard can sign in.
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const { error } = await createClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        setError(error.message);
        return;
      }
      router.replace(safeNext(searchParams.get("next")));
      router.refresh();
    });
  }

  const inputClass =
    "h-12 w-full rounded-xl border border-border bg-surface px-4 outline-none focus:border-accent";

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">🧠 2nd Brain</h1>
      <p className="mb-6 text-sm text-muted">Sign in to your brain.</p>

      <form onSubmit={signIn} className="space-y-3">
        <input
          type="email"
          name="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={inputClass}
        />
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className={inputClass}
        />
        <button disabled={pending} className="h-12 w-full rounded-xl bg-accent font-medium text-white disabled:opacity-60">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
    </main>
  );
}
