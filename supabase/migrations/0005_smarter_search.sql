-- 2nd Brain — smarter search. Additive only: safe to run before or after
-- deploying the matching code.

-- Typo tolerance ("octopis" → octopus) via trigram word similarity.
create extension if not exists pg_trgm with schema extensions;

create index if not exists logs_caption_trgm_idx
  on public.logs using gin (caption extensions.gin_trgm_ops);

-- Cached query embeddings: Voyage's free tier allows 3 requests/minute, so a
-- repeated search should never spend one.
create table if not exists public.query_embeddings (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  query text not null,
  model text not null,
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  primary key (user_id, model, query)
);

alter table public.query_embeddings enable row level security;

create policy "own query cache: select" on public.query_embeddings
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own query cache: insert" on public.query_embeddings
  for insert to authenticated with check (user_id = (select auth.uid()));

-- hybrid_search now also reports whether each hit matched by words
-- (keyword/typo) or only by meaning, so the UI can say so.
drop function if exists public.hybrid_search(text, extensions.vector, int, float, float, int);

create function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(1024),
  match_count int default 30,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns table (id uuid, score float, similarity float, keyword_match boolean)
language sql
stable
security invoker
set search_path = public, extensions
as $$
with full_text as (
  select
    l.id,
    row_number() over (
      order by
        ts_rank_cd(l.fts, public.any_terms_query(query_text)) desc,
        word_similarity(query_text, l.caption) desc
    ) as rank_ix
  from logs l
  where l.fts @@ public.any_terms_query(query_text)
     -- Fallbacks only for queries with real words (a stopword-only query
     -- like "the" would otherwise substring-match every log):
     or (
       public.any_terms_query(query_text) is not null
       and (
         -- partial words ("octo") and numbers
         l.caption ilike '%' || query_text || '%'
         or public.tags_to_text(l.tags) ilike '%' || query_text || '%'
         -- typos ("caffiene"): measured typo matches score >= 0.44, noise <= 0.25
         or (length(query_text) >= 4 and word_similarity(query_text, l.caption) >= 0.4)
       )
     )
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
  s.similarity,
  f.id is not null as keyword_match
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
