-- 2nd Brain — Phase 2: neighbour graph + map positions.

-- Match ANY of the query's terms ("cognitive bias" finds logs with just
-- "bias"); ts_rank_cd still ranks logs matching more terms higher.
create or replace function public.any_terms_query(query_text text)
returns tsquery
language sql
immutable
as $$
select to_tsquery('simple', string_agg(quote_literal(lexeme), ' | '))
from unnest(tsvector_to_array(to_tsvector('english', query_text))) as lexeme
$$;

-- Fixes: OR semantics for terms (above), and an ORDER BY before LIMIT in the
-- full-text CTE (otherwise Postgres may keep an arbitrary subset of matches).
create or replace function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(1024),
  match_count int default 30,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns table (id uuid, score float, similarity float)
language sql
stable
security invoker
set search_path = public, extensions
as $$
with full_text as (
  select
    l.id,
    row_number() over (
      order by ts_rank_cd(l.fts, public.any_terms_query(query_text)) desc
    ) as rank_ix
  from logs l
  where l.fts @@ public.any_terms_query(query_text)
     -- Substring fallback so partial words ("octo") and numbers still match.
     or l.caption ilike '%' || query_text || '%'
     or public.tags_to_text(l.tags) ilike '%' || query_text || '%'
  order by rank_ix
  limit match_count * 2
),
semantic as (
  select
    l.id,
    1 - (l.embedding <=> query_embedding) as similarity,
    row_number() over (order by l.embedding <=> query_embedding) as rank_ix
  from logs l
  where query_embedding is not null
    and l.embedding is not null
  order by l.embedding <=> query_embedding
  limit match_count * 2
)
select
  coalesce(f.id, s.id) as id,
  coalesce(1.0 / (rrf_k + f.rank_ix), 0.0) * full_text_weight
    + coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight as score,
  s.similarity
from full_text f
full outer join semantic s on f.id = s.id
-- Drop weak semantic-only hits so unrelated logs don't pad the results.
where f.id is not null or s.similarity >= 0.35
order by score desc
limit match_count;
$$;

-- Each log's own top-k most similar logs (directed; never bumped by others).
-- The map uses the union of both directions as its edges.
create table public.log_neighbors (
  log_id uuid not null references public.logs (id) on delete cascade,
  neighbor_id uuid not null references public.logs (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  similarity real not null,
  primary key (log_id, neighbor_id)
);

create index log_neighbors_user_idx on public.log_neighbors (user_id);
create index log_neighbors_neighbor_idx on public.log_neighbors (neighbor_id);

alter table public.log_neighbors enable row level security;

create policy "own neighbors: select" on public.log_neighbors
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own neighbors: insert" on public.log_neighbors
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own neighbors: delete" on public.log_neighbors
  for delete to authenticated using (user_id = (select auth.uid()));

-- Recompute one log's neighbour list. Called after every (re-)embed.
-- Neighbours are restricted to the same owner, so this is also safe when
-- run with the secret key (cron), which bypasses RLS.
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
  order by l.embedding <=> t.embedding
  limit k
) n
where t.id = target_id
  and t.embedding is not null
  and n.similarity >= min_similarity;
$$;

-- Rebuild every log's list (daily cron). Fixes similarities that went stale
-- when a neighbour was edited. Exact scan; fine for a personal corpus.
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
  for r in select id from logs where embedding is not null loop
    perform refresh_neighbors(r.id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Bulk-save map positions after a layout run: [{ "id": ..., "x": ..., "y": ... }, ...]
create or replace function public.save_positions(positions jsonb)
returns int
language sql
security invoker
set search_path = public
as $$
with updated as (
  update logs l
  set x = p.x, y = p.y
  from jsonb_to_recordset(positions) as p (id uuid, x real, y real)
  where l.id = p.id
  returning 1
)
select count(*)::int from updated;
$$;

-- Saving positions must not bump updated_at (that tracks content edits).
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (new.caption, new.tags, new.source_url, new.image_path)
     is distinct from (old.caption, old.tags, old.source_url, old.image_path) then
    new.updated_at = now();
  end if;
  return new;
end;
$$;
