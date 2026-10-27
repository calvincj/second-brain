-- 2nd Brain — "Move to region": a thought can be pinned to the region of
-- another thought (its anchor). Pinning to a thought, not a region number,
-- survives regions being recomputed. Additive: safe before or after deploy.

alter table public.logs
  add column if not exists region_anchor uuid references public.logs (id) on delete set null;
