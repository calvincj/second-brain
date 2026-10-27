-- 2nd Brain — 3D brain map.

-- Third coordinate for the 3D layout. Old 2D positions mean nothing in 3D,
-- so clear them; the map lays everything out again on next open.
alter table public.logs add column if not exists z real;
update public.logs set x = null, y = null, z = null;

-- Bulk-save 3D positions: [{ "id": ..., "x": ..., "y": ..., "z": ... }, ...]
create or replace function public.save_positions(positions jsonb)
returns int
language sql
security invoker
set search_path = public
as $$
with updated as (
  update logs l
  set x = p.x, y = p.y, z = p.z
  from jsonb_to_recordset(positions) as p (id uuid, x real, y real, z real)
  where l.id = p.id
  returning 1
)
select count(*)::int from updated;
$$;

-- The "Rediscover" card was removed.
drop function if exists public.random_logs(int, uuid);
