# 2nd Brain — Build Plan

Log facts, stats, and phenomena from laptop or phone; look them up by term; browse them as a "neural network" map where related ideas cluster and search zooms to the match.

## Requirements
- Capture from laptop or phone: one-line fact, optional source link, optional image/screenshot
- Look up by terms → matching + related logs
- Map view: semantically related logs bunched together; searching zooms there
- Relatedness via AI embeddings
- Hosted web app, single user

## Stack
| Layer | Choice | Notes |
|---|---|---|
| App | Next.js (App Router, TS) | Web manifest + icons only, **no service worker** (iOS doesn't need one; avoids stale-build bugs) |
| DB / auth / files | Supabase: Postgres + pgvector + Storage | Built-in email is fine (you're the project owner); long-lived sessions |
| Embeddings | Voyage `voyage-3.5-lite`, 1024 dims | `input_type=document` on save, `query` on search; server-only key |
| Map | Sigma.js + graphology + ForceAtlas2 (web worker) | Client-only dynamic import |
| Hosting | Vercel | Git-push deploy, daily cron |

## Auth & security
- Supabase **email + password** (single account created in the dashboard). Magic links won't work, because they open in Safari, outside the home-screen app's storage; OTP codes would need custom SMTP to edit the email template. Passwords need no email at all and iOS Keychain autofills them.
- Use the new **publishable/secret API keys** (`sb_publishable_…` / `sb_secret_…`), not the legacy `anon`/`service_role` JWTs (deprecated late 2026). Secret key and Voyage key live only in Vercel env vars / `.env.local` (gitignored).
- Signups disabled. RLS on all tables and the Storage bucket.
- Private image bucket; signed URLs generated in batch for lists.

## Data model
```
logs
  id uuid, user_id,
  caption text NOT NULL          -- the fact (required, even for screenshots)
  tags text[]                    -- optional, user-typed
  source_url text,               -- UI shows its domain
  image_path text,
  created_at, updated_at,
  embedding vector(1024) NULL,   -- null until embedded
  embedding_model text,
  fts tsvector GENERATED         -- caption + tags
  x real NULL, y real NULL       -- map position (Phase 2)

-- Phase 2
log_neighbors                    -- DIRECTED: each log's own top-k, never bumped by others
  log_id, neighbor_id, similarity
```
- Embedded text = caption + tags.
- No vector index needed below ~10k rows (exact scan = ms). HNSW if ever needed.

## Save pipeline
1. Insert row → embed (in the same request, after insert) → update row. A failed embed never loses the log.
2. Unembedded logs show a "retry" action; the daily cron backfills them and also keeps the Supabase free tier from pausing (it must run a real query).
3. Edit → re-embed. Delete → remove image from Storage (+ neighbors cascade).
4. Client: canvas-resize images to ~1600px JPEG/WebP (fixes HEIC, size, EXIF orientation); draft autosaved to localStorage.

## Search ("look up by terms")
- One SQL function: hybrid reciprocal-rank fusion of full-text + vector similarity. Exact terms matter for stats, semantic matching catches paraphrases.
- Logs without embeddings still match via full-text.
- **Related logs** on the detail view: live vector query.

## Map (Phase 2)
- **Edges:** directed top-k with k = min(5, n/10). Keep an edge only if its similarity is above a corpus-relative cutoff (e.g. the median neighbor similarity), so unrelated logs genuinely float to the edge. Edges are the union of both directions.
- **Layout:** ForceAtlas2 with edge weight = similarity, seeded from the saved x/y so the map evolves rather than reshuffles.
- **Auto re-layout:** when the map opens and there are unpositioned logs, recompute `log_neighbors`, place new logs at their neighbors' centroid (+ jitter), run a few hundred iterations in the worker, then save all positions in one bulk RPC. If two devices both write, last write wins, which is fine.
- **Unembedded logs:** parked in a ring at the periphery.
- **Visual:** nodes only by default. Selecting a node lights up its edges (the "synapses"). Labels appear when zoomed in or highlighted.
- **Search → zoom:** fly to the top hit's neighborhood; other hits get ring markers + a results list (tap to fly).
- **Detail:** bottom sheet on mobile, side panel on desktop; ~44px tap targets.
- **Cold start:** list view stays the default until ~50 logs.

## Phases
**Phase 1: Capture, search, related (weekend-sized)**
Supabase project (pgvector, RLS, bucket, signups off) · Next.js scaffold · password login · manifest/icons · quick-add (caption, tags, link, image resize, draft autosave) · insert-then-embed · list view · hybrid search · detail + related logs · edit/delete · JSON/Markdown export · daily cron (keep-alive + backfill) · deploy · install on phone. ✅ Built.

**Phase 2: Brain map**
`log_neighbors` · Sigma.js view · ForceAtlas2 worker · auto re-layout + bulk save · interaction-lit edges · search-to-zoom · mobile tuning. ✅ Built (Louvain cluster colouring pulled forward from Phase 3).

**Phase 3: Optional polish** (built: tag filter chips, background link titles with SSRF guards; remaining items below are still open)
Optional Claude cluster names · vision caption suggestions for screenshots · auto-fetched link titles (with SSRF guards) · filters · random-fact resurfacing.

**Phase 4: 3D brain (built)**
Home screen is a full-3D, bioluminescent brain (3d-force-graph / three.js): neurons with additive glow (bloom on desktop), regions = seeded Louvain communities shown as coloured nebulae with unique auto names, region cohesion + gentle centre gravity so regions pack like lobes. Search = live keyword preview while typing, semantic on pause/Enter; hits ignite and activation spreads hop-by-hop as travelling pulses, camera frames everything lit. Tap a neuron → it fires, card with connected thoughts + breadcrumb trail. Logging gives birth to a neuron that flies to its region and wires itself in ("Connected to: …"). Ambient twinkle, sparks, slow auto-rotate (off with Reduce Motion). Positions persisted in 3D (x,y,z). Rediscover removed; list moved to `/list`.

## Tuning notes (measured on real voyage-3.5-lite embeddings, 42 labelled facts)
- Any two short facts score 0.56–0.77 cosine, even unrelated ones (unrelated avg 0.62, related 0.71); queries score 0.40–0.56. Fixed thresholds don't work.
- Search keeps semantic-only hits within 0.08 of the best match **and** only when ≥2 hits are clear outliers (z ≥ 2): 100% on-topic for relevant queries, empty for queries with no relevant logs ("zzzqqq" otherwise matched at 0.49).
- Related shows the top 2 plus anything within 0.04 of the closest (≈73% on-topic, 3.5 shown). Raw similarity % is hidden in the UI because it misleads.
- Map keeps k = clamp(n/15, 1, 3) links per log (k=3 → 7 clusters for 7 topics, 93% purity; k=4 merged topics to 70%). Low-repulsion ForceAtlas2 (scalingRatio 0.5, gravity 0.2) gives ~20% tighter clusters.

## Verify before building
- Voyage free-tier rate limits without a card (reportedly ~3 RPM), which affects backfill. Add a card or throttle.
- Sign in from inside the installed home-screen app, not Safari (save the password to Keychain).

## Non-goals
3D view, native apps, share sheet, offline queue, long-form notes. Scale target ~10k logs.
