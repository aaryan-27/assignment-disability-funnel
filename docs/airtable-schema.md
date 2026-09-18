# Airtable schema

Four tables. The design goal is that **adding a funnel question must never
require an Airtable migration** — which is why answers live in a tall table
rather than one column per question.

Create a new base and add the tables below. Field names are case-sensitive and
must match exactly; the workflow writes by name.

> **The live base differs from this spec, and the n8n workflow targets the live
> base.** There, `Leads.lead_id` is an autonumber, so the funnel's `ld_…` id is
> stored in `funnel_lead_id` (the idempotency key). The `lead_id` field in
> `Qualification` and `Automation Runs` is a link to `Leads`. Statuses map onto
> the base's select options (`review` → `In Progress`). Outcome, reasons and
> referrer go into `notes`. The in-process mock (`apps/api/src/services/n8n/workflow.ts`)
> still follows the spec below.

---

## 1. `Leads`

One row per lead. `lead_id` is the idempotency key — the workflow searches on it
before every write.

| Field | Type | Notes |
|---|---|---|
| `lead_id` | Single line text | **Primary field.** `ld_…`. Unique in practice, enforced by the workflow. |
| `created_at` | Date (ISO, include time) | Server timestamp. Never the client clock. |
| `first_name` | Single line text | |
| `last_name` | Single line text | |
| `email` | Email | Lowercased before write. |
| `phone` | Phone number | Digits only, E.164-ish (`14155550132`). |
| `funnel_version` | Single line text | Which funnel produced this lead. Essential when A/B testing. |
| `source` | Single line text | `utm_source`, defaults to `direct`. |
| `medium` | Single line text | `utm_medium`. |
| `campaign` | Single line text | `utm_campaign`. |
| `content` | Single line text | `utm_content`. Ad-level attribution. |
| `term` | Single line text | `utm_term`. |
| `fbclid` | Single line text | Raw Meta click id, kept for offline-conversion uploads. |
| `landing_page` | URL | |
| `referrer` | Single line text | |
| `lead_status` | Single select | `new`, `qualified`, `review`, `disqualified`, `duplicate` |
| `qualification_outcome` | Single select | `qualified`, `review`, `disqualified` |
| `qualification_score` | Number (integer) | 0–100. Drives the call-queue priority. |
| `qualification_reasons` | Long text | Comma-separated reason codes. **Internal only** — never leaves for an ad platform. |
| `conversion_event_id` | Single line text | `evt_…`. The shared Pixel/CAPI dedup key. Lets you reconcile a row here against a conversion in Meta Events Manager. |
| `last_synced_at` | Date (include time) | Updated on every write, including replays. |

**Recommended views**

- `Call queue` — filter `lead_status` is any of `qualified`, `review`; sort by
  `qualification_score` descending, then `created_at` ascending.
- `Needs attention` — filter `last_synced_at` is empty.
- `By campaign` — group by `campaign`, for spend-vs-quality review.

---

## 2. `Qualification`

One row per answered question — an Entity-Attribute-Value shape.

| Field | Type | Notes |
|---|---|---|
| `qualification_id` | Formula or Autonumber | Optional; Airtable's record id is sufficient. |
| `lead_id` | Single line text | Join key back to `Leads`. Convert to a Link field if you prefer native linking. |
| `question_id` | Single line text | e.g. `under_medical_care`. Matches the funnel config id exactly. |
| `answer` | Single line text | Option value, or `\|`-joined for multi-select. |
| `timestamp` | Date (include time) | |

**Why EAV rather than a wide table**

A funnel changes weekly. With one column per question, every new question is a
schema change in Airtable, a change in the n8n field mapping, and a backfill.
With one row per answer, adding question 16 is a config edit in the repo and
nothing else moves. The cost is that reporting needs a pivot — the right trade
for a funnel that is still being optimised.

⚠️ **This table holds health information.** Restrict it with Airtable field and
table permissions, and keep it out of any view shared with an external
collaborator.

---

## 3. `Events`

Conversion and funnel telemetry. Optional in Airtable — the API is the system of
record — but useful when non-engineers need to answer "did this lead's
conversion actually reach Meta?".

| Field | Type | Notes |
|---|---|---|
| `event_id` | Single line text | **Primary field.** `evt_…`. The dedup key. |
| `lead_id` | Single line text | Empty for pre-lead events. |
| `event_name` | Single select | `PageView`, `ViewContent`, `FunnelStarted`, `QuestionCompleted`, `QualificationStarted`, `QualificationCompleted`, `EmailCaptured`, `Lead` |
| `timestamp` | Date (include time) | |
| `source` | Single select | `browser`, `server` |
| `status` | Single select | `received`, `sent`, `failed`, `skipped`, `duplicate` |

---

## 4. `Automation Runs`

The audit trail. Every workflow execution writes here, including the ones that
did nothing because they were duplicates.

| Field | Type | Notes |
|---|---|---|
| `run_id` | Autonumber | **Primary field.** |
| `lead_id` | Single line text | |
| `event_id` | Single line text | |
| `workflow` | Single line text | e.g. `lead_to_airtable` |
| `status` | Single select | `pending`, `in_progress`, `succeeded`, `failed`, `dead_letter`, `duplicate_ignored` |
| `retry_count` | Number (integer) | |
| `error` | Long text | Populated on failure. |
| `last_attempt` | Date (include time) | |
| `duration_ms` | Number (integer) | Handy for spotting a slow downstream before it starts failing. |

**Recommended view**

- `Failures` — filter `status` is any of `failed`, `dead_letter`. If this view is
  not empty, leads are being captured but not delivered.

---

## Setup

1. Create the base and the four tables above.
2. Create a personal access token at
   <https://airtable.com/create/tokens> with scopes `data.records:read` and
   `data.records:write`, granted on this base only.
3. Copy the base id from the API docs URL
   (`https://airtable.com/appXXXXXXXXXXXXXX/api/docs`) — it starts with `app`.
4. Put both into `.env` as `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID`.
5. Set `MOCK_AIRTABLE=false` and restart.

The API writes with Airtable's `typecast: true`, so a new single-select option
(a new firm in `attorney_firm`, say) is created automatically rather than
failing the write.

## Why Airtable is not the system of record

Airtable is the **operational CRM** — the surface a non-technical operator uses
to work the leads. It is not the durable store:

- no unique constraints, so idempotency has to be enforced by the caller;
- rate limited to 5 requests/second per base;
- no transactions, so a multi-table write can partially apply.

The API therefore commits every lead to its own store first and treats the
Airtable write as a retryable side effect. If Airtable is down for an hour,
nothing is lost — the outbox drains when it returns. See the README's
**Failure recovery strategy**.
