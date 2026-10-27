-- 2nd Brain — soft delete. Deleting marks a log; the daily cron purges it a
-- week later. Undo works even if the app was closed mid-undo.

alter table public.logs add column if not exists deleted_at timestamptz;

-- Deleted logs are invisible to the app: every read (brain, search, related,
-- tags, list, export) goes through RLS, so they all skip them automatically.
drop policy if exists "own logs: select" on public.logs;
create policy "own logs: select" on public.logs
  for select to authenticated
  using (user_id = (select auth.uid()) and deleted_at is null);

-- Delete. Postgres checks an updated row against the SELECT policy too, and a
-- deleted row fails it by design, so a plain UPDATE is refused; this function
-- checks ownership itself instead.
create or replace function public.soft_delete_log(target_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
with deleted as (
  update logs
  set deleted_at = now()
  where id = target_id and user_id = auth.uid() and deleted_at is null
  returning 1
)
select exists (select 1 from deleted);
$$;

revoke all on function public.soft_delete_log(uuid) from public, anon;
grant execute on function public.soft_delete_log(uuid) to authenticated;

-- Undo. A deleted row is no longer visible to its owner, so restoring needs
-- a function that checks ownership itself.
create or replace function public.restore_log(target_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
with restored as (
  update logs
  set deleted_at = null
  where id = target_id and user_id = auth.uid() and deleted_at is not null
  returning 1
)
select exists (select 1 from restored);
$$;

revoke all on function public.restore_log(uuid) from public, anon;
grant execute on function public.restore_log(uuid) to authenticated;

-- Never pick a deleted log as a neighbour (the cron runs this with the secret
-- key, which bypasses RLS).
create or replace function public.refresh_neighbors(
  target_id uuid,
  k int default 8,
  min_similarity float default 0.2
)
returns void
language sql
security invoker
set search_path = public, extensions
as $$
delete from log_neighbors where log_id = target_id;

insert into log_neighbors (log_id, neighbor_id, user_id, similarity)
select t.id, n.id, t.user_id, n.similarity
from logs t
cross join lateral (
  select l.id, 1 - (l.embedding <=> t.embedding) as similarity
  from logs l
  where l.user_id = t.user_id
    and l.id <> t.id
    and l.embedding is not null
    and l.deleted_at is null
  order by l.embedding <=> t.embedding
  limit k
) n
where t.id = target_id
  and t.embedding is not null
  and t.deleted_at is null
  and n.similarity >= min_similarity;
$$;

create or replace function public.rebuild_all_neighbors()
returns int
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  r record;
  n int := 0;
begin
  for r in select id from logs where embedding is not null and deleted_at is null loop
    perform refresh_neighbors(r.id);
    n := n + 1;
  end loop;
  return n;
end;
$$;
