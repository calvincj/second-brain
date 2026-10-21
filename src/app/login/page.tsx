"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";

// Email + password: no emails to send (so no custom SMTP), and iOS Keychain
// autofills it inside the home-screen app. Signups are disabled, so only the
// account created in the Supabase dashboard can sign in.
export default function LoginPage() {
  const router = useRouter();
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
      router.replace("/");
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
