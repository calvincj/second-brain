-- 2nd Brain — personal capture token for iOS Shortcuts / Share Sheet.
-- Only a SHA-256 hash is stored; the token itself is shown once.
-- Additive: safe to run before or after deploying the matching code.

alter table public.brain_settings add column if not exists capture_token_hash text;

create unique index if not exists brain_settings_capture_token_idx
  on public.brain_settings (capture_token_hash)
  where capture_token_hash is not null;
