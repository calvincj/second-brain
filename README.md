# 🧠 2nd Brain

Log facts, stats and phenomena from laptop or phone. Find them by term or by idea.
See [PLAN.md](PLAN.md) for the full design and tuning notes.

**What it does**
- **The brain (home):** a 3D, bioluminescent map of your thoughts. Related thoughts cluster into named, coloured regions; bridges between regions glow in both colours.
- **Search:** type and matching neurons fire, the signal spreading to related thoughts. Handles typos ("octopis"), questions ("what do I know about sleep?") and meaning (matched "by meaning" when no words overlap). Results list grouped by region.
- **Log:** type in the bar and tap ＋. A new neuron is born, wires itself in, and tells you what it connected to (with one-tap tag suggestions).
- **Tap a neuron:** its card, connected thoughts (hop between them), edit, move to another region, delete with Undo.
- **A memory stirs:** once a day an older thought you haven't seen in a while wakes up.
- **While you were away:** thoughts captured elsewhere replay their births when you return.
- **Log from anywhere:** an iPhone Shortcut / Share Sheet / Siri via a personal token (menu → iPhone Shortcut…), or the fast `/capture` page.
- **List view** (`/list`) for scanning, tags and bulk reading.

## Setup

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com), region **West US (North California)**.
2. **SQL Editor** → paste and run each file in [`supabase/migrations/`](supabase/migrations/) in order: `0001_init.sql` → `0009_region_pins.sql`. (Already ran some? Just run the ones you haven't, in order.)
3. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up". Leave the **Email** provider itself **enabled**.
4. **Authentication → Users → Add user → Create new user**: your email + a strong password, with **Auto Confirm User** checked. That's your login (no emails are ever sent, so no SMTP setup is needed).
5. **Project Settings → API Keys**: copy the Project URL, **publishable** key and **secret** key.

### 2. Voyage AI
Create an API key at [voyageai.com](https://www.voyageai.com). Adding a card is optional; it lifts the free 3 requests/min limit (cost stays ~$0).

### 3. Local env
```bash
cp .env.example .env.local   # already done; fill in the values
openssl rand -hex 32         # use as CRON_SECRET
npm run dev                  # http://localhost:3000
```

#### Fully local (no cloud accounts)
With Docker running, `npx supabase start` runs Supabase locally with both migrations applied
(create a user in Studio at http://127.0.0.1:54323 → Authentication). Point the `NEXT_PUBLIC_SUPABASE_*` /
`SUPABASE_SECRET_KEY` env vars at the printed local values. If `VOYAGE_API_KEY` is empty in
development, a crude offline mock embedding is used so everything still works.

### 4. Deploy (Vercel)
1. Push this repo to GitHub, import it in Vercel.
2. Add the same five env vars in Vercel → Settings → Environment Variables.
3. The daily cron in [`vercel.json`](vercel.json) keeps Supabase from pausing and backfills any logs that failed to embed.

### 5. Install on your phone
Open the deployed URL in **Safari** → Share → **Add to Home Screen** → open the app from the icon and sign in **there** (the home-screen app has its own storage, separate from Safari). Save the password to Keychain when iOS offers.

## Tests
End-to-end smoke test (72 checks across login, logging, search, the 3D brain, edit/move/delete/undo, memories, capture API, sheets):
```bash
npx supabase start && npx supabase db reset   # local Supabase only; never touches your real project
npm run test:e2e                               # screenshots land in e2e/out/
```

## Backups
**Export** (top right) downloads every log as JSON; `/api/export?format=md` gives Markdown. Images stay in Supabase Storage.

## Layout
```
src/proxy.ts                 session refresh + login gate
src/app/actions.ts           create / update / delete / retry-embed
src/app/page.tsx             the 3D brain (home)
src/app/list/page.tsx        quick-add, search, tags, recent list
src/app/log/[id]/page.tsx    detail, edit, related logs
src/app/login/page.tsx       email + password sign-in
src/components/brain/        3D brain: renderer (three.js) + UI (search, regions, cards, sheets)
src/app/capture/             fast 3D-free capture page
src/app/api/capture          token-authenticated capture API (iOS Shortcuts)
src/lib/brain-model.ts       edges, regions + names, spreading activation
src/app/api/cron             keep-alive, embedding backfill, neighbour rebuild
src/app/api/export           JSON / Markdown export
src/lib/embeddings.ts        Voyage client
src/lib/queries.ts           reads (hybrid search, related, signed image URLs)
supabase/migrations/         schema, RLS, search, neighbours, storage bucket
```
