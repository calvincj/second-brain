import "server-only";
import { createClient } from "@supabase/supabase-js";

// Bypasses RLS. Only for trusted server jobs (cron backfill).
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
