# 🧠 2nd Brain

Log facts, stats and phenomena from laptop or phone. Find them by term or by idea.
See [PLAN.md](PLAN.md) for the full design. This is **Phase 1**: capture, search, related logs.

## Setup

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com), region **West US (North California)**.
2. **SQL Editor** → paste and run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
3. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
4. **Authentication → Users → Add user**: add your own email (auto-confirm).
5. **Authentication → Emails → Magic Link** template: replace the body with something containing `{{ .Token }}`, e.g.
   ```html
   <h2>Your 2nd Brain code</h2>
   <p style="font-size:24px;letter-spacing:4px"><b>{{ .Token }}</b></p>
   ```
   (Without this, Supabase emails a link instead of a code, and links don't work in the home-screen app.)
6. **Project Settings → API Keys**: copy the Project URL, **publishable** key and **secret** key.

### 2. Voyage AI
Create an API key at [voyageai.com](https://www.voyageai.com). Adding a card is optional; it lifts the free 3 requests/min limit (cost stays ~$0).

### 3. Local env
```bash
cp .env.example .env.local   # already done; fill in the values
openssl rand -hex 32         # use as CRON_SECRET
npm run dev                  # http://localhost:3000
```

### 4. Deploy (Vercel)
1. Push this repo to GitHub, import it in Vercel.
2. Add the same five env vars in Vercel → Settings → Environment Variables.
3. The daily cron in [`vercel.json`](vercel.json) keeps Supabase from pausing and backfills any logs that failed to embed.

### 5. Install on your phone
Open the deployed URL in **Safari** → Share → **Add to Home Screen** → open the app from the icon and sign in **there** (the home-screen app has its own storage, separate from Safari).

## Backups
**Export** (top right) downloads every log as JSON; `/api/export?format=md` gives Markdown. Images stay in Supabase Storage.

## Layout
```
src/proxy.ts                 session refresh + login gate
src/app/actions.ts           create / update / delete / retry-embed
src/app/page.tsx             quick-add, search, recent list
src/app/log/[id]/page.tsx    detail, edit, related logs
src/app/login/page.tsx       email OTP sign-in
src/app/api/cron             keep-alive + embedding backfill
src/app/api/export           JSON / Markdown export
src/lib/embeddings.ts        Voyage client
src/lib/queries.ts           reads (hybrid search, related, signed image URLs)
supabase/migrations/         schema, RLS, search functions, storage bucket
```
# second-brain
