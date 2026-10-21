"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";

// Email one-time code, not a magic link: links open in Safari, outside the
// home-screen app's storage, so the session would never reach the app.
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const { error } = await createClient().auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false },
      });
      if (error) setError(error.message);
      else setStep("code");
    });
  }

  function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const { error } = await createClient().auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email",
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
  const buttonClass =
    "h-12 w-full rounded-xl bg-accent font-medium text-white disabled:opacity-60";

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">🧠 2nd Brain</h1>
      <p className="mb-6 text-sm text-muted">
        {step === "email" ? "Sign in with your email." : `Enter the code sent to ${email}.`}
      </p>

      {step === "email" ? (
        <form onSubmit={sendCode} className="space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
          <button disabled={pending} className={buttonClass}>
            {pending ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="space-y-3">
          <input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6,8}"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className={`${inputClass} tracking-[0.3em]`}
          />
          <button disabled={pending} className={buttonClass}>
            {pending ? "Checking…" : "Sign in"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
            }}
            className="h-11 w-full text-sm text-muted"
          >
            Use a different email
          </button>
        </form>
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
    </main>
  );
}
