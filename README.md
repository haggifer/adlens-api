# adlens-api

Backend for **AdLens** — AI video-ad diagnostics. You upload a video ad, it is analyzed against a
~150-rule ad-policy set with Gemini, and you get back cited, per-rule findings. This repo is the API
and the analysis worker; the web client and the shared types live in their own repos.

- Web (Next.js on Vercel): <https://github.com/haggifer/adlens>
- Shared types (published to npm, pinned): [`adlens-shared`](https://github.com/haggifer/adlens-shared)

## Architecture

```
                 bearer token (Better Auth)
   Browser ───────────────────────────────────────────┐
 (Next.js on Vercel)                                   │
     │  1. REST /v1/*  ·  /api/auth/*                   │
     │  2. Socket.IO (job:updated)  ◄──────────┐        │
     │  3. signed PUT (video bytes) ──► GCS     │        ▼
     ▼                                  │       │  ┌──────────────────────────┐
 ┌───────────────────────────┐         │       │  │  API — NestJS 11          │
 │ Cloud Run: adlens-api      │─────────┼───────┘  │  on Cloud Run             │
 │  node dist/main            │         │          │  (node dist/main)         │
 │  · Better Auth (MongoDB)   │         │          └──────────────────────────┘
 │  · Mongoose ─────────────► MongoDB Atlas ◄── Change Streams ─┘
 │  · GCS V4 signed URLs      │         (users/quotas/jobs)
 │  · launches analysis job ──┼──► Cloud Run Job: adlens-analyze
 └───────────────────────────┘         node dist/job (on-demand, runs once, exits)
                                          │  · reads video from GCS (gs:// URI)
                                          │  · Gemini on Vertex AI
                                          └─► writes result.json to GCS + analysis back to MongoDB
```

- **Web** — Next.js on Vercel. Talks to the API over REST and Socket.IO; uploads the video straight
  to GCS with a signed URL.
- **API** — NestJS 11 on Cloud Run (`node dist/main`), Mongoose on MongoDB Atlas, Better Auth
  (email/password, bearer tokens), Socket.IO for realtime, GCS for storage.
- **Analysis** — a separate **on-demand Cloud Run Job** (`adlens-analyze`, `node dist/job`) that the
  API launches per request and that runs the pipeline once and exits.
- **Realtime** — a MongoDB **Change Stream** on the `jobs` collection fans updates out over
  **Socket.IO** to the owner's room. The client never polls.
- **Auth** — Better Auth issues bearer tokens; the API verifies the session on every `/v1/*` request
  and on the socket handshake.

## Access-control model

**The client is never the boundary — the API is the only process that reads or writes MongoDB.**

- **Ownership by `userId`, enforced twice** — [`SessionGuard`](src/auth/session.guard.ts) resolves the
  caller's `userId` from the Better Auth session (never from the body), and **every** query is scoped
  by that `userId` (`findOne({ _id, userId })`, `find({ userId })`, `updateOne({ _id, userId })`).
  A caller can only ever touch their own rows.
- **The client's only direct write is the upload** — the video binary goes straight to GCS via a
  short-lived (15 min) **V4 signed PUT URL** minted by the API for a path derived from the caller's
  `userId`. Everything else is a server write through a validated endpoint (Zod allowlist on the body,
  so no mass assignment).
- **Bytes are verified before quota is spent** — on `analyze`, the API downloads the uploaded object
  and runs **ffprobe** to prove it is a real, decodable video within the duration cap. Only after
  verification succeeds is a run counted; a bad upload is deleted and costs nothing.
- **Quota is unspoofable** — it lives in a server-owned `quotas` document and is incremented in a
  single atomic `findOneAndUpdate` guarded by `used < limit`.

## API surface

Every `/v1/*` route requires `Authorization: Bearer <token>`;
[`SessionGuard`](src/auth/session.guard.ts) verifies the Better Auth session and injects `userId`.
The Better Auth handler and health check are public.

| Method & path                | Auth      | Purpose                                                               | Returns             |
| ---------------------------- | --------- | --------------------------------------------------------------------- | ------------------- |
| `ALL /api/auth/*`            | public    | Better Auth (sign-up / sign-in / session), mounted via `toNodeHandler`| Better Auth         |
| `GET /health`                | public    | Liveness probe                                                        | `{ status, ... }`   |
| `POST /v1/jobs`              | bearer    | Create a `pending` job, return it + a signed upload URL               | `{ job, uploadUrl }`|
| `POST /v1/jobs/:id/analyze`  | bearer    | Verify upload → consume quota → launch analysis                       | **202** `{ job }`   |
| `GET /v1/jobs`               | bearer    | List the caller's jobs (newest first, capped at 50)                   | `{ jobs }`          |
| `GET /v1/jobs/:id`           | bearer    | Get one owned job                                                     | `{ job }`           |
| `GET /v1/me/profile`         | bearer    | Get the caller's profile                                             | `{ profile }`       |
| `PATCH /v1/me/profile`       | bearer    | Update allowlisted profile fields                                    | `{ profile }`       |
| `GET /v1/me/quota`           | bearer    | Get the caller's quota window                                        | `{ quota }`         |

`POST /v1/jobs/:id/analyze` returns **202 Accepted** — verification and quota are synchronous, but the
analysis itself runs out-of-band in the Cloud Run Job.

## The flow

1. `POST /v1/jobs { settings, file }` → the API creates a `pending` job, reserves the upload path
   `users/{userId}/{timestamp}/{filename}`, and returns the job plus a **V4 signed PUT URL**.
2. The client **PUTs the video bytes** straight to GCS with that URL. No bytes pass through the API.
3. `POST /v1/jobs/:id/analyze` → the API loads the owned job, then **verifies the bytes**
   ([`verify.service.ts`](src/analysis/verify.service.ts): ffprobe for duration/dimensions/audio, ≤180s
   cap). On failure it deletes the object, marks the job `error`, and returns 422 — **no quota spent**.
4. On success it **consumes quota** ([`quota.service.ts`](src/quota/quota.service.ts), default 3/week,
   atomic; 429 if spent), stores the media facts, and marks the job `queued`.
5. It **launches the analysis** ([`analysis-launcher.service.ts`](src/analysis/analysis-launcher.service.ts)):
   a `runJob` call to the **Cloud Run Admin API** starts an execution of the `adlens-analyze` job,
   passing `ANALYZE_USER_ID` / `ANALYZE_JOB_ID` as container env overrides. (Locally, `ANALYZE_LOCAL=1`
   runs the pipeline in-process via `setImmediate` instead, so no GCP job is needed.) The endpoint
   returns **202**.
6. The job ([`job.ts`](src/job.ts) → [`analysis-runner.service.ts`](src/analysis/analysis-runner.service.ts))
   sets the job `analyzing`, selects the relevant rules, checks the metadata rules in code, runs **one
   multimodal Gemini pass** over the video for the content rules (transcript + per-rule findings), builds
   the advisory checklist, writes a `result.json` into the upload folder, and sets the job `analyzed`
   with the full `analysis`. The runner is **idempotent** — it returns early if the job is already
   `analyzed`, so a Cloud Run retry can't double-analyze. Exit codes: `0` success, `1` failure (Cloud
   Run retries), `2` misconfiguration.
7. The status transitions (`pending → queued → analyzing → analyzed`/`error`) are writes to the `jobs`
   collection. A **Change Stream** ([`job-events.service.ts`](src/realtime/job-events.service.ts)) turns
   each update into a **Socket.IO** `job:updated` event to the owner's room; the client re-renders live.

## Ad-policy rules

The ruleset is **static and bundled** ([`src/rules/rules.json`](src/rules/rules.json)) — no scraper, no
database. Each rule carries a `modality` that drives routing ([`src/rules/index.ts`](src/rules/index.ts)):

- `metadata` → checked **in code** against the extracted media facts (duration, dimensions, filesize).
- `text` / `visual` / `audiovisual` → projected to `{ id, check, severity, modality }` and evaluated by
  the **multimodal model** over the video. `quote` + resolved `ref` are attached back by id for citation
  (they never cost prompt tokens). Rule ids the model returns that weren't sent are dropped as a
  hallucination guard.
- `out_of_creative` (targeting / local-law / verification) → surfaced as an **advisory checklist**,
  never auto-judged.

Rules are validated with a Zod schema ([`src/rules/schema.ts`](src/rules/schema.ts)) at load.
Backreferences use a `{{SOURCE_KEY}}` URL dictionary resolved via `resolveRef`. To regenerate, follow
`rule_distillation_guide.md`, drop the new file in as `src/rules/rules.json`, and bump its
`meta.version`.

## Data model

MongoDB Atlas. **Better Auth** owns the identity collections (`user`, `session`, `account`,
`verification`) via its own `MongoClient`; **Mongoose** owns the application collections:

- **`profiles`** ([`profile.schema.ts`](src/schemas/profile.schema.ts)) — `{ userId, displayName?,
  photoURL? }`, `timestamps`. Unique index on `userId`.
- **`quotas`** ([`quota.schema.ts`](src/schemas/quota.schema.ts)) — `{ userId, used, limit,
  windowStart }`. Unique index on `userId`. Created lazily on first analyze; rolling weekly window.
- **`jobs`** ([`job.schema.ts`](src/schemas/job.schema.ts)) — `{ userId, status, settings, file, media?,
  analysis?, error?, execution? }`, `timestamps`. Index on `userId`, plus a compound
  `{ userId: 1, createdAt: -1 }` for the list query. The Change Stream watches this collection.

Shared shapes (`Job`, `AnalysisSettings`, `Analysis`, `Finding`, …) come from the pinned
[`adlens-shared`](https://github.com/haggifer/adlens-shared) npm package.

**GCS object layout** (one bucket): each upload gets its own folder
`users/{userId}/{timestamp}/{filename}` holding the uploaded video and the server-written
`result.json` (the analysis artifact) beside it.

## Gemini

[`src/gemini/gemini.ts`](src/gemini/gemini.ts) uses **Vertex AI** (`vertexai: true`), authenticated via
**ADC** — no API key to manage. The runner passes the video's `gs://` URI straight to `generateContent`,
so Vertex reads the object directly from GCS. The model is `gemini-3.6-flash` by default (override with
`GEMINI_MODEL`). The Gemini 3.x models are served from the multi-region **`global`** endpoint (not
`us-central1`), so the client location defaults to `global` (override with `GEMINI_LOCATION`).

## Environment

Read by `ConfigService` (from `.env` locally, from env vars / Secret Manager on Cloud Run) unless noted:

| Variable                | Required | Default                 | Purpose                                                                        |
| ----------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------ |
| `MONGODB_URI`           | **yes**  | —                       | MongoDB Atlas connection string (Mongoose + Better Auth + Change Stream).      |
| `BETTER_AUTH_SECRET`    | **yes**  | —                       | Better Auth signing secret.                                                    |
| `STORAGE_BUCKET`        | **yes**  | —                       | The one GCS bucket for uploads and result artifacts.                           |
| `BETTER_AUTH_URL`       | no       | `http://localhost:8080` | The API's own public base URL (must be set to the real URL in production).     |
| `WEB_ORIGIN`            | no       | `http://localhost:3000` | The web client origin — allowed for CORS and as a Better Auth trusted origin.  |
| `ALLOWED_ORIGINS`       | no       | —                       | Extra CORS origins, comma-separated.                                           |
| `PORT`                  | no       | `8080`                  | HTTP listen port (API only).                                                   |
| `STORAGE_KEY_FILE`      | no       | —                       | Path to a SA key file used only to sign V4 URLs locally (user ADC can't sign). |
| `GOOGLE_CLOUD_PROJECT`  | no*      | —                       | GCP project for the Cloud Run Job launch and for Vertex (`GCLOUD_PROJECT` also read as a fallback). Required in the cloud. |
| `GCP_REGION`            | no       | `europe-west1`          | Region of the analysis Cloud Run Job.                                          |
| `ANALYZE_JOB_NAME`      | no       | `adlens-analyze`        | Name of the Cloud Run Job the API launches.                                    |
| `ANALYZE_LOCAL`         | no       | —                       | `1` runs analysis in-process instead of launching the job (local dev).         |
| `QUOTA_LIMIT`           | no       | `3`                     | Runs allowed per rolling weekly window.                                        |
| `GEMINI_MODEL`          | no       | `gemini-3.6-flash`      | Gemini model override (read via `process.env`).                                |
| `GEMINI_LOCATION`       | no       | `global`                | Vertex serving location override (read via `process.env`).                     |

The analysis job additionally receives `ANALYZE_USER_ID` and `ANALYZE_JOB_ID` as env overrides from the
launcher (read directly in [`src/job.ts`](src/job.ts)), not from `ConfigService`.

*`GOOGLE_CLOUD_PROJECT` is optional in code (empty-string fallback) but required for a real job launch
and for Vertex, so it is effectively required in the cloud.

## Local development

```bash
gcloud auth application-default login    # once; account needs the Vertex AI User role
npm install
# .env: MONGODB_URI (Atlas), BETTER_AUTH_SECRET, STORAGE_BUCKET, ANALYZE_LOCAL=1,
#       and STORAGE_KEY_FILE if your user ADC can't sign V4 URLs
npm run start:dev
```

With `ANALYZE_LOCAL=1` the analysis runs in-process, so no Cloud Run Job is needed. Vertex reads the
real `gs://` object from GCS, so a real bucket plus ADC are required for the analysis step; auth, job
creation, verification, quota, and realtime all work against Atlas + GCS without any GCP job.

Then run the web client (`cd ../adlens && npm run dev`) and point its `NEXT_PUBLIC_API_BASE_URL` at the
local API.

## Deployment

One idempotent-ish gcloud script, [`infra/setup.sh`](infra/setup.sh) (Pulumi/Terraform deliberately
skipped — see [DECISIONS.md](DECISIONS.md)). It enables the APIs, ensures the uploads bucket and a
runtime service account (Vertex user, bucket object admin, `signBlob` on itself, and `serviceAccountUser`
so the API can launch the job as the SA), stores `MONGODB_URI` / `BETTER_AUTH_SECRET` in Secret Manager,
then:

- deploys the **`adlens-analyze`** Cloud Run **Job** (`node dist/job`, 1 task, 2 retries, 15m timeout);
- deploys the **`adlens-api`** Cloud Run **service** (`node dist/main`) with `run.developer` on the job
  so it can launch executions;
- sets `BETTER_AUTH_URL` to the API's own deployed URL.

```bash
export MONGODB_URI='mongodb+srv://…/adlens'
export BETTER_AUTH_SECRET='<long random string>'
export WEB_ORIGIN='https://<your-vercel-app>.vercel.app'
bash infra/setup.sh
```

## Tests

Jest (unit + spec files alongside the code, e.g. `analysis-launcher.service.spec.ts`).

```bash
npm test
```

## Decisions and what I'd change

See [DECISIONS.md](DECISIONS.md) for the full log.

The one worth calling out is **sizing the architecture to the load**. Analysis was originally a
BullMQ worker backed by Redis — an always-on service plus a managed Redis instance, sitting idle
almost all the time for a 3-runs-per-week-per-user product where each run is a single long
(minutes-scale) Gemini pass. That is a queue-and-worker shape solving a throughput problem this
product doesn't have. It was replaced with an **on-demand Cloud Run Job** the API launches per
request: no idle worker, no Redis, scale-to-zero, and the per-run isolation (its own retries and
15-minute timeout) that a long multimodal job actually wants. MongoDB already holds the job status
and Change Streams already drive realtime, so removing the queue cost no functionality. If sustained
throughput ever became real, a pull queue in front of the job (or back to a worker pool) would be the
answer — but not before the load justifies it.
