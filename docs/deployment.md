# Deploying to Vercel

The web app ships as static files and the API as one serverless function
(`api/index.mjs`). Work through this list top to bottom. Every step can be
checked with the verification section at the end.

## 1. Database (required)

A Vercel function's filesystem is read-only and not shared between instances,
so the JSON file store cannot hold leads there. Attach Postgres:

1. Vercel dashboard → your project → **Storage** → **Create Database** → **Neon**
   (free tier is enough) → connect it to the project for all environments.
2. The integration adds `POSTGRES_URL` (and `DATABASE_URL`) automatically.
   The API accepts either one.

The API creates its table (`funnel_store`) on first request. No migration step.

Without a database the API falls back to `/tmp`, which is wiped whenever an
instance recycles. The startup log warns about this.

## 2. Environment variables

Set these under **Settings → Environment Variables** for Production. Copy
secrets from your local `.env`; never commit them.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://<your-domain>` |
| `CORS_ALLOWED_ORIGINS` | `https://<your-domain>` |
| `FUNNEL_VERSION` | `qualification-v1` |
| `MOCK_MODE`, `MOCK_META`, `MOCK_AIRTABLE`, `MOCK_N8N` | `false` |
| `META_PIXEL_ID` | your pixel ID |
| `META_ACCESS_TOKEN` | Conversions API token (see §4) |
| `META_API_VERSION` | `v26.0` |
| `META_CAPI_ENABLED` | `true` |
| `META_TEST_EVENT_CODE` | **leave unset** (only set it while testing, see §4) |
| `N8N_WEBHOOK_URL` | production webhook URL from n8n |
| `N8N_WEBHOOK_SECRET` | long random string, same value as in the n8n workflow |
| `N8N_TIMEOUT_MS` | `20000` |
| `ADMIN_API_TOKEN` | at least 24 random characters. `/admin` refuses to work with the placeholder. |
| `CRON_SECRET` | long random string (used by the scheduled drain) |
| `VITE_META_PIXEL_ID` | same as `META_PIXEL_ID`. Build-time, so redeploy after changing it. |

`AIRTABLE_*` variables are only used by the local n8n simulator. In production
n8n writes to Airtable with its own credential.

Generate random values with `openssl rand -hex 32`.

## 3. n8n

1. Import `n8n/lead-to-airtable.workflow.json`.
2. In **Verify & Validate**, set `FALLBACK_WEBHOOK_SECRET` (= `N8N_WEBHOOK_SECRET`)
   and `FALLBACK_AIRTABLE_BASE_ID`. Hosted n8n blocks `$env`, so these
   constants are how the values get in.
3. Select your Airtable credential on the six Airtable nodes.
4. The **Webhook** node's Authentication must be **None**. Requests are
   authenticated by the `X-Funnel-Signature` check inside Verify & Validate.
5. Activate the workflow and use the **Production** URL (not `/webhook-test/`).

## 4. Meta

### What you need

| Item | Where to get it |
|---|---|
| Pixel (dataset) ID | Events Manager → Data sources → your pixel → **Settings** |
| Conversions API access token | Same page → **Conversions API** → **Generate access token**. It is a system-user token that does not expire. |
| Test event code | Events Manager → pixel → **Test events** tab |
| Verified domain | Business Settings → Brand safety → **Domains** → add domain → verify by DNS TXT record |

### Go-live sequence

1. Deploy with `META_TEST_EVENT_CODE` set to the code from the Test events tab.
2. Complete the funnel on the live domain. In **Test events** you should see
   `PageView`, `CompleteRegistration` and `Lead` twice each, once **Browser**
   and once **Server**, and marked **Deduplicated**.
3. Remove `META_TEST_EVENT_CODE` and redeploy. Events now count for ads.
4. Verify the domain, then in Events Manager → **Aggregated Event
   Measurement** (web events configuration) rank `Lead` first.
5. After 24–48 hours of traffic, check **Overview → Event match quality**
   for `Lead` (aim for 6.0+) and **Diagnostics** for warnings.

### How delivery is protected

- **Every conversion is sent twice**, by the Pixel and by the Conversions API,
  with the same `event_id`, so Meta counts it once. If an ad blocker stops the
  Pixel, the server copy still arrives.
- **Server events go through the outbox.** A Meta outage never loses a
  conversion. It is retried with backoff until Meta accepts it, and events
  older than Meta's 7-day window are dropped instead of retried.
- **On Vercel**, jobs are drained right after each response. A daily cron
  (`/api/cron/drain`) catches retries that came due while the site was quiet,
  plus any job a killed function left `in_progress`. That job is reclaimed
  after 5 minutes. On a Pro plan, change the schedule in `vercel.json` to
  `*/5 * * * *` for faster retries.
- **Match keys sent:** hashed email, phone, first and last name, gender,
  `external_id` (the visitor's persisted session ID, also given to the Pixel),
  plus `fbp`, `fbc` (rebuilt from `fbclid` when the cookie is missing), IP and
  user agent.
- **Privacy:** answers, health details and qualification reasons never reach
  Meta. The allowlist in `@funnel/shared` enforces this.

### Health-category restrictions

Meta may classify a disability-benefits site as health-related and restrict
some data or optimisation. The funnel sends only standard events and no
answer data, which is the compliant setup. If Diagnostics shows a
"restricted data" notice, optimise campaigns for the standard `Lead` event
and avoid custom events in the ad set.

## 5. Verify after deploy

```bash
curl https://<domain>/health                 # {"ok":true,...}
curl https://<domain>/ready                  # integrations all "live", store "postgres"
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/drain
```

Then submit the funnel once. Check the Airtable Leads row, the Test events tab
in Meta, and **Vercel → Logs** for any `config.production_warning` lines.
Each one names a setting to fix.

## Known limits

- The Postgres store keeps each collection as one JSONB document and reads the
  whole dataset per transaction. That is fine to tens of thousands of events.
  Beyond that, move to normalised tables behind `store/repository.ts`.
- The rate limiter is per instance, so the effective limit grows with the
  number of warm instances.
- Two *identical* submissions arriving at the same instant (not a normal retry)
  can both create a lead, because the idempotency check and the insert run in
  separate transactions. Normal retries and double-clicks after the first
  response are deduplicated.
