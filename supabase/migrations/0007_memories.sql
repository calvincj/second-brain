-- 2nd Brain — resurfacing + shared layout version. Additive: safe to run
-- before or after deploying the matching code.

-- When a thought was last looked at, so "a memory stirs" can pick ones
-- you haven't seen in a while.
alter table public.logs add column if not exists last_viewed_at timestamptz;

-- Per-user brain settings shared by every device (phone, laptop): which
-- layout rules the saved positions were made with.
create table if not exists public.brain_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  layout_version text,
  updated_at timestamptz not null default now()
);

alter table public.brain_settings enable row level security;

create policy "own settings: select" on public.brain_settings
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own settings: insert" on public.brain_settings
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own settings: update" on public.brain_settings
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
