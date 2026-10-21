-- 2nd Brain — initial schema.
-- Run once in the Supabase SQL editor (or `supabase db push`).

create extension if not exists vector with schema extensions;

-- array_to_string isn't immutable, so generated columns can't use it directly.
create or replace function public.tags_to_text(tags text[])
returns text
language sql
immutable
as $$ select coalesce(array_to_string(tags, ' '), '') $$;

create table public.logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  caption text not null check (length(trim(caption)) > 0),
  tags text[] not null default '{}',
  source_url text,
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  embedding extensions.vector(1024),
  embedding_model text,
  fts tsvector generated always as (
    to_tsvector('english', caption || ' ' || public.tags_to_text(tags))
  ) stored,
  -- Map position, written by the Phase 2 re-layout.
  x real,
  y real
);

create index logs_user_created_idx on public.logs (user_id, created_at desc);
create index logs_fts_idx on public.logs using gin (fts);
-- No vector index: an exact scan is milliseconds below ~10k rows.
-- If ever needed: create index on public.logs using hnsw (embedding vector_cosine_ops);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger logs_touch_updated_at
before update on public.logs
for each row execute function public.touch_updated_at();

-- Row level security: every row belongs to exactly one user.
alter table public.logs enable row level security;

create policy "own logs: select" on public.logs
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own logs: insert" on public.logs
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own logs: update" on public.logs
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "own logs: delete" on public.logs
  for delete to authenticated using (user_id = (select auth.uid()));

-- Hybrid search: reciprocal rank fusion of full-text and semantic matches.
-- query_embedding may be null (embedding API down) → full-text only.
-- security invoker, so RLS still limits results to the caller's logs.
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
      order by ts_rank_cd(l.fts, websearch_to_tsquery('english', query_text)) desc
    ) as rank_ix
  from logs l
  where l.fts @@ websearch_to_tsquery('english', query_text)
     -- Substring fallback so partial words ("octo") and numbers still match.
     or l.caption ilike '%' || query_text || '%'
     or public.tags_to_text(l.tags) ilike '%' || query_text || '%'
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

-- Nearest neighbours of one log, by cosine similarity.
-- min_similarity keeps unrelated logs out of "Related" when the corpus is small.
create or replace function public.related_logs(
  target_id uuid,
  match_count int default 8,
  min_similarity float default 0.35
)
returns table (id uuid, similarity float)
language sql
stable
security invoker
set search_path = public, extensions
as $$
select l.id, 1 - (l.embedding <=> t.embedding) as similarity
from logs l, logs t
where t.id = target_id
  and t.embedding is not null
  and l.embedding is not null
  and l.id <> t.id
  and 1 - (l.embedding <=> t.embedding) >= min_similarity
order by l.embedding <=> t.embedding
limit match_count;
$$;

-- Private image bucket. Files live under "<user_id>/<file>".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('log-images', 'log-images', false, 5242880, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do nothing;

create policy "own images: select" on storage.objects
  for select to authenticated
  using (bucket_id = 'log-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own images: insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'log-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own images: delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'log-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
