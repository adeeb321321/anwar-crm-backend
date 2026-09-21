# Anwar Al-Juntain — WhatsApp CRM Backend

Backend API + scheduler + webhook for the أنوار الجنتين WhatsApp
campaign system. Node.js + Express + PostgreSQL.

This replaces the old browser-only localStorage app. The scheduler
that sends campaign batches now runs **inside this backend process**,
so campaigns keep running even if every phone and browser is closed.

## What's in here

```
src/
  server.js            entry point — wires everything together
  db/
    schema.sql          full database schema (run via migrate.js)
    pool.js              PostgreSQL connection pool
    migrate.js           applies schema.sql (safe to re-run)
    seed.js               creates your first admin login
    import-csv.js         one-time import of the master customer CSV
  services/
    whatsapp.js           all calls to Meta's Graph API go through here
    campaigns.js           targeting/filtering + campaign lifecycle logic
  jobs/
    scheduler.js           THE FIX — server-side batch scheduler (node-cron)
  routes/
    auth.js, customers.js, products.js, templates.js,
    campaigns.js, reports.js, webhook.js
  middleware/auth.js       JWT auth guard
  utils/audit.js           audit log helper
```

## 1. Deploy to Railway (recommended — simplest option that supports
a real always-on backend + free Postgres for testing)

1. Go to https://railway.app and sign up / log in (GitHub login is
   easiest).
2. Push this folder to a new GitHub repository (or use Railway's
   "Deploy from local folder" if you don't want GitHub yet — but
   GitHub makes future updates much easier).
3. In Railway: **New Project → Deploy from GitHub repo** → select
   this repo.
4. In the same project, click **+ New → Database → Add PostgreSQL**.
   Railway automatically creates a `DATABASE_URL` variable and makes
   it available to your backend service.
5. Click on your backend service → **Variables** tab → add all the
   variables listed in `.env.example` EXCEPT `DATABASE_URL` (Railway
   already injected that one for you). At minimum for now:
   - `JWT_SECRET` — generate one: run `openssl rand -hex 32` on any
     terminal, or ask me to generate one for you.
   - `WEBHOOK_VERIFY_TOKEN` — invent any secret string, e.g.
     `anwar_wh_2026_x7k2` — remember it, you'll type it into Meta's
     dashboard in a later step.
   - Leave `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
     `WHATSAPP_BUSINESS_ACCOUNT_ID`, and `META_APP_SECRET` empty for
     now — we'll fill these once your real number is linked in
     Meta's Step 2 (Production setup).
6. Railway will build and deploy automatically. Once it's live, it
   gives you a public URL like:
   `https://anwar-crm-backend-production.up.railway.app`
7. Open Railway's **Deployments → View Logs** and confirm you see:
   ```
   [server] listening on port ...
   [scheduler] started -- checking for due campaign batches every minute.
   ```

## 2. Run the database migration (creates all tables)

Railway gives you a "Shell" / one-off command runner under your
service's **Settings**, or you can run migrations locally against the
Railway database by copying its `DATABASE_URL` into a local `.env`:

```bash
npm install
npm run migrate
```

You should see:
```
[migrate] applying schema.sql ...
[migrate] done. All tables/indexes are up to date.
```

## 3. Create your admin login

```bash
node src/db/seed.js "Adeeb" "your@email.com" "a-strong-password"
```

Use this email/password to log in from the PWA once it's connected
(`POST /api/auth/login`).

## 4. Import the master customer CSV

```bash
node src/db/import-csv.js /path/to/انوار_الجنتين_قاعدة_العملاء_MASTER_v2.csv
```

This is safe to re-run any time you get an updated CSV export — it
upserts by phone number rather than duplicating rows, and it never
deletes anything.

## 5. Set the webhook Callback URL in Meta

Now that your backend has a real public URL, go back to the Meta
Developers page where it asked for **Callback URL** and **Verify
token**:

- **Callback URL**: `https://<your-railway-url>/webhook`
- **Verify token**: the exact same value you set as
  `WEBHOOK_VERIFY_TOKEN` in Railway's variables.

Meta will immediately call your `/webhook` URL to verify it — if the
token matches, you'll see `[webhook] verification succeeded` in
Railway's logs.

## 6. Fill in the real WhatsApp credentials

Once Step 2 (Production setup) in Meta gives you the real values for
your +967712191198 number, add these to Railway's Variables:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `META_APP_SECRET` (from App Settings → Basic → App Secret)

Railway redeploys automatically when you save new variables.

## API overview (for the PWA frontend to call)

All routes except `/api/auth/login` and `/webhook` require:
`Authorization: Bearer <token>`

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | get a JWT |
| GET | `/api/customers` | list/search/filter customers |
| GET | `/api/customers/stats` | dashboard numbers |
| POST | `/api/customers/:id/opt-out` | "إيقاف الرسائل لهذا العميل" |
| GET/POST/PATCH | `/api/products` | product management |
| GET/POST/PATCH | `/api/templates` | WhatsApp template management |
| GET | `/api/campaigns` | list campaigns |
| POST | `/api/campaigns` | create draft campaign |
| GET | `/api/campaigns/preview/audience` | "معاينة العملاء" — count only |
| POST | `/api/campaigns/:id/prepare` | freeze recipient list + batches |
| POST | `/api/campaigns/:id/start` | "بدء الحملة" (also resumes) |
| POST | `/api/campaigns/:id/pause` | "إيقاف الحملة" |
| GET | `/api/campaigns/:id` | full status + recipient breakdown |
| GET | `/api/reports/dashboard` | all dashboard numbers |

## Notes on design decisions

- **Scheduler**: runs via `node-cron` inside this same process,
  ticking every minute. This is what makes campaigns survive phone
  screen locks and closed browsers — the fix for the #1 problem in
  the previous version.
- **Duplicate prevention**: enforced at the database level via
  `UNIQUE(campaign_id, customer_id)` on `campaign_recipients` — not
  just application logic.
- **Retries**: only Meta error codes known to be transient (rate
  limits, temporary server errors) are retried, with exponential
  backoff, up to `max_retries` (default 3). Permanent failures
  (invalid number, blocked, template rejected) are never retried.
- **Crash recovery**: `campaign_recipients.status` and
  `campaigns.current_batch_number` together mean the scheduler always
  knows exactly where it left off — no re-sends on restart.
- **Consent**: campaigns default to `opted_in_only = true`. The
  legacy CSV data has NOT been marked as opted-in by default (Meta's
  own policies determine what counts as valid consent for marketing
  templates) — you'll want to decide how to backfill consent status
  before your first real campaign; happy to help design that flow
  next.
