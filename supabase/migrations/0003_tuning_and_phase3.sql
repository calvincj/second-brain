-- 2nd Brain — tune matching on real Voyage embeddings.
--
-- Measured on voyage-3.5-lite with short facts: every pair of logs scores
-- 0.56-0.77 cosine, even unrelated ones (unrelated avg 0.62, related 0.71),
-- and queries score 0.40-0.56. Fixed thresholds can't separate that, so
-- cutoffs are now relative to the best match.

-- Search: a semantic-only hit (no keyword match) is kept when it is
--   * within 0.08 of the best semantic match (95% on-topic in testing), and
--   * a clear outlier for this query (z-score >= 2 against all logs), and
--   * not alone: at least two hits stand out like that.
-- The last two stop queries with no relevant logs ("zzzqqq" scores 0.49
-- against an unrelated fact!) from returning noise: relevant queries had 3-4
-- outliers, irrelevant ones at most one. Below 10 logs the statistics are
-- meaningless, so only the first rule applies.
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
stats as (
  select
    count(*) as n,
    avg(1 - (l.embedding <=> query_embedding)) as mu,
    stddev_pop(1 - (l.embedding <=> query_embedding)) as sd
  from logs l
  where query_embedding is not null
    and l.embedding is not null
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
),
scored as (
  select s.*, (s.similarity - st.mu) / nullif(st.sd, 0) as z
  from semantic s, stats st
),
best as (
  select
    max(similarity) as top,
    count(*) filter (where z >= 2) as outliers,
    (select n from stats) as n
  from scored
)
select
  coalesce(f.id, s.id) as id,
  coalesce(1.0 / (rrf_k + f.rank_ix), 0.0) * full_text_weight
    + coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight as score,
  s.similarity
from full_text f
full outer join scored s on f.id = s.id
cross join best
where f.id is not null
   or (
     s.similarity >= best.top - 0.08
     and (best.n < 10 or (s.z >= 2 and best.outliers >= 2))
     -- Sanity floor. Real embeddings never score this low; it also keeps the
     -- offline mock embedder's sparse hash collisions out of results.
     and s.similarity >= 0.1
   )
order by score desc
limit match_count;
$$;

-- Related: a log's nearest two neighbours are on-topic ~85% of the time, and
-- accuracy drops quickly after that. Always show the top 2, plus any others
-- within 0.04 of the closest one.
drop function if exists public.related_logs(uuid, int, float);

create function public.related_logs(
  target_id uuid,
  match_count int default 6,
  window_size float default 0.04
)
returns table (id uuid, similarity float)
language sql
stable
security invoker
set search_path = public, extensions
as $$
with ranked as (
  select
    l.id,
    1 - (l.embedding <=> t.embedding) as similarity,
    row_number() over (order by l.embedding <=> t.embedding) as rank_ix
  from logs l, logs t
  where t.id = target_id
    and t.embedding is not null
    and l.embedding is not null
    and l.id <> t.id
  order by l.embedding <=> t.embedding
  limit match_count
)
select r.id, r.similarity
from ranked r
where r.rank_ix <= 2
   or r.similarity >= (select max(similarity) from ranked) - window_size
order by r.rank_ix;
$$;

-- Phase 3 ---------------------------------------------------------------------

-- Page title fetched in the background after save. Display only (not embedded),
-- since fetched titles are often junk ("Just a moment...", login walls).
alter table public.logs add column if not exists source_title text;

-- Tag chips on the home screen, most used first.
create or replace function public.tag_counts(max_tags int default 12)
returns table (tag text, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
select t.tag, count(*) as n
from logs, unnest(tags) as t (tag)
group by t.tag
order by n desc, t.tag
limit max_tags;
$$;

-- "Rediscover": random logs, preferring ones older than a day so the card
-- surfaces things you might have forgotten.
create or replace function public.random_logs(n int default 1, exclude_id uuid default null)
returns setof public.logs
language sql
volatile
security invoker
set search_path = public
as $$
select *
from logs
where exclude_id is null or id <> exclude_id
order by (created_at < now() - interval '1 day') desc, random()
limit n;
$$;
