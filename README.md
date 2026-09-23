# adlens-api

Backend for **AdLens**, AI video-ad diagnostics. You upload a short video ad; it is verified, analyzed against a
~150-rule ad-policy set with one Gemini pass, and you get cited, timestamped findings pushed to the browser in
realtime. This repo holds the HTTP API and the analysis worker; the web client and the API contract live in their own
repos.

- Web (Next.js on Vercel): <https://github.com/haggifer/adlens>
- API contract (Zod schemas, published to npm): [`adlens-shared`](https://github.com/haggifer/adlens-shared)

## Architecture

```
 Browser (Next.js on Vercel)
   │  REST /v1/*  ·  /api/auth/*  ·  Socket.IO job:updated        signed PUT (exact type + size)
   ▼                                                                   │
 ┌──────────────────────────────┐      runJob(WORKER_JOB_ID)      ┌────▼──────────────┐
 │ Cloud Run service: adlens-api │ ─────────────────────────────►  │ GCS uploads bucket │
 │ node dist/main               │                                  └────▲──────────────┘
 │ · Better Auth · verification │   ┌──────────────────────────────┐    │ gs:// URI
 │ · quota · job lifecycle      │   │ Cloud Run Job: adlens-analyze │    │
 └──────┬───────────────▲───────┘   │ node dist/worker (on demand)  │────┘
        │ Mongoose       │ Change    │ · rules · Gemini on Vertex    │
        ▼                │ Stream    └──────────────┬───────────────┘
      MongoDB Atlas ─────┘  (jobs, quotas, Better Auth collections) ◄┘
```

- **API** (`src/main.ts` → `AppModule`): NestJS 11 on Cloud Run at `api.useadlens.com`. Better Auth, Mongoose on Atlas,
  GCS signed URLs, ffprobe verification, quota, Socket.IO.
- **Worker** (`src/worker.ts` → `WorkerModule`): the same image run as an **on-demand Cloud Run Job**. The API starts
  one execution per analysis; the worker analyzes that job once and exits. It has no HTTP layer and no dispatcher, so
  it can never start another worker.
- **Realtime**: a MongoDB Change Stream on `jobs` pushes every update to the owner's Socket.IO room. The stream is
  reopened from its last resume token after errors.
- **Contract**: every request body, response and error has a Zod schema in `adlens-shared`. The API returns the
  public job shape only; owner, storage paths, execution names and accounting stay server-side.

## Job lifecycle

`pending → verifying → queued → analyzing → analyzed | error`

[`JobLifecycle`](src/jobs/job-lifecycle.service.ts) is the single owner of a job's status. Every transition is one
conditional update on the expected current status, so two racing callers can never both win (a double-clicked
"analyze" can't verify, charge or dispatch twice).

1. **Create** `POST /v1/jobs`: a `pending` job and a V4 signed PUT URL that binds the declared content type **and exact
   size** (`x-goog-content-length-range`), so the stored object must match the declaration.
2. **Start** `POST /v1/jobs/:id/analyze` ([`JobAnalysisService`](src/jobs/job-analysis.service.ts)):
   - **claim** `pending → verifying` (409 `JOB_NOT_PENDING` for a second caller);
   - **verify** ([`VideoVerifier`](src/jobs/verification/video-verifier.service.ts)) from the stored object's own
     metadata plus ffprobe over a signed read URL (range reads, no download). A bad file (unreadable, too long, too
     large, unsupported type) is rejected with 422 and deleted. A missing upload (409 `UPLOAD_INCOMPLETE`) or a storage
     or network problem (503) puts the job back to `pending` and never deletes the user's file;
   - **charge** one run and move to `queued` (429 `QUOTA_EXCEEDED` when the window is spent);
   - **dispatch** the worker. If that fails, the job goes back to `pending` and the charge is refunded (503).
3. **Analyze** ([`AnalysisPipeline`](src/analysis/pipeline/analysis-pipeline.service.ts)): `queued → analyzing`,
   select the rules for the chosen platforms and markets, check the metadata rules in code, run one Gemini pass through
   the [`VideoReviewer`](src/analysis/review/video-reviewer.ts) port, then `analyzing → analyzed`.
4. **Fail well**: the worker knows its attempt (`CLOUD_RUN_TASK_ATTEMPT`). A transient failure (provider overload,
   network, timeout) exits 1 so Cloud Run retries it; a permanent failure, or any failure on the last attempt, ends
   the job in `error` with `ANALYSIS_FAILED`. The Gemini call has a 10-minute timeout, well inside the 15-minute task
   timeout.
5. **Nothing stays in flight forever**: when a user reads their jobs, anything stuck (a worker that crashed or never
   started) is expired: `verifying` after 10 minutes goes back to `pending`, `queued`/`analyzing` after 60 minutes ends
   as `ANALYSIS_TIMED_OUT`.

**Quota** ([`QuotaService`](src/quota/quota.service.ts)): N analyses per rolling 7-day window that starts with the
first analysis. A charge is one conditional pipeline update, so concurrent requests can't overdraw. The job records
the window it was charged to (`chargedWindowStart`); ending a run clears that field in the same write that sets the
final status, and the pre-image decides who refunds, so a refund happens at most once and only into the window the
charge came from.

## Authentication

[Better Auth](src/auth/auth.instance.ts) on the app's own Mongo connection, email and password:

- **Sessions are httpOnly, `SameSite=Lax` cookies.** The web app (`www.useadlens.com`) and the API (`api.useadlens.com`)
  share the parent domain (`COOKIE_DOMAIN`), so the cookie is first-party for both and no token ever sits in
  JavaScript-readable storage. Socket.IO authenticates its handshake with the same cookie.
- **Email verification is required** before the first sign-in; the link signs the user in and returns them to the web
  app. Signing in unverified resends it.
- **Password reset** by emailed link (1-hour token); a reset revokes every existing session.
- **Account deletion** (password-confirmed) purges the user's jobs, quota and every uploaded object before Better Auth
  removes the account.
- Emails go through Resend from `mail.useadlens.com` and are sent without awaiting, so response timing doesn't reveal
  whether an address has an account. Rate limits are stored in MongoDB so they hold across instances.

## API

Every `/v1/*` route requires a session; [`SessionGuard`](src/auth/session.guard.ts) resolves the user from the Better Auth
session cookie (never from the body) and every query is scoped by it. Errors share one shape,
`{ statusCode, errorCode, message, issues? }`, with `errorCode` from `adlens-shared`.

| Method & path               | Purpose                                                         | Returns                        |
| --------------------------- | --------------------------------------------------------------- | ------------------------------ |
| `ALL /api/auth/*`           | Better Auth (public)                                            | Better Auth                    |
| `GET /health`               | Liveness (public)                                               | `{ status, service, time }`    |
| `POST /v1/jobs`             | Create a pending job and its signed upload target               | `{ job, upload }`              |
| `POST /v1/jobs/:id/analyze` | Verify → charge → dispatch                                      | **202** `{ job }`              |
| `GET /v1/jobs`              | The caller's jobs, newest first (`?limit=` ≤ 50, `?cursor=`)    | `{ jobs, nextCursor }`         |
| `GET /v1/jobs/:id`          | One owned job                                                   | `{ job }`                      |
| `GET /v1/jobs/:id/video`    | A 15-minute signed URL for replaying the verified upload        | `{ url, expiresAt }`           |
| `GET /v1/me/quota`          | The caller's quota window                                       | `{ quota }`                    |

## Ad-policy rules

Rules are data. The authored ruleset lives in [`src/rules/rules.json`](src/rules/rules.json) and is published to MongoDB
as an **immutable version** with `npm run rules:publish` (validated by the same Zod schema the worker parses it with; a
version that already exists is refused). The worker serves the newest published version via
[`RulesetService`](src/rules/ruleset.service.ts), so a rules update needs no redeploy, and every analysis records the
`rulesetVersion` it ran with.

Selection ([`src/rules/index.ts`](src/rules/index.ts)) targets the job's settings: its **platforms** (YouTube also pulls
in Google Ads policy), its **markets** (global rules always apply; UK/EU/US rules only in their market) and, for
format-specific rules such as the 6-second bumper cap, its **placements**. A test proves every rule is reachable from
some combination of settings. Selected rules are then routed by `modality`:

- `metadata` → checked in code against the measured media facts (duration, dimensions, real object size);
- `text` / `visual` / `audiovisual` → sent to the model as `{ id, check, severity, modality }`; quote and resolved
  source link are attached back by id, and ids the model invents are dropped;
- `out_of_creative` → an advisory checklist, never auto-judged.

Every analysis records `model`, `promptVersion` and `rulesetVersion`, plus token usage on the job for cost tracking.

## Code map

```
src/
  main.ts · app.module.ts           API process
  worker.ts · worker.module.ts      analysis worker process
  config/env.ts                     one Zod-validated env schema for both processes
  database/                         Mongo connection + document schemas (Zod → Mongoose via zodToMongoose)
  jobs/                             REST endpoints, JobLifecycle (status owner), start orchestration, verification
  analysis/dispatch/                AnalysisDispatcher: Cloud Run Job execution, or a local child process in dev
  analysis/review/                  VideoReviewer port + Gemini on Vertex implementation + prompt/output schema
  analysis/pipeline/                the worker's pipeline and retry classification
  rules/                            ruleset schema and serving, selection, metadata checks, finding assembly
scripts/publish-ruleset.ts          publishes rules.json as a new immutable ruleset version
  quota/ · me/                      quota accounting and GET /v1/me/quota
  realtime/                         Change Stream → Socket.IO
  auth/                             Better Auth on the app's Mongo connection, session guard
```

## Environment

All variables are validated at startup by [`src/config/env.ts`](src/config/env.ts); a missing or malformed value stops
the process with a readable error. Locally they come from `.env` (non-secret, committed) and `.env.local` (secrets).

| Variable                 | Default                 | Purpose                                                                     |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------- |
| `MONGODB_URI`            | required                | Atlas connection string (Mongoose, Better Auth, Change Stream)              |
| `GOOGLE_CLOUD_PROJECT`   | required                | GCP project for Vertex and Cloud Run                                        |
| `STORAGE_BUCKET`         | required                | The uploads bucket                                                          |
| `BETTER_AUTH_SECRET`     | required by the API     | Better Auth signing secret                                                  |
| `BETTER_AUTH_URL`        | `http://localhost:8080` | The API's own public URL                                                    |
| `WEB_ORIGIN`             | `http://localhost:3000` | The one web origin allowed by CORS, Socket.IO and Better Auth               |
| `COOKIE_DOMAIN`          | —                       | Parent domain for the session cookie in production (`useadlens.com`)        |
| `RESEND_API_KEY`         | —                       | Resend sending key; without it, auth emails are printed to the console      |
| `MAIL_FROM`              | `AdLens <no-reply@mail.useadlens.com>` | Sender of auth emails                                      |
| `PORT`                   | `8080`                  | API listen port                                                             |
| `STORAGE_KEY_FILE`       | —                       | Local only: SA key used to sign V4 URLs (user ADC can't sign)               |
| `GCP_REGION`             | `europe-west1`          | Region of the analysis Cloud Run Job                                        |
| `ANALYZE_JOB_NAME`       | `adlens-analyze`        | The Cloud Run Job the API executes                                          |
| `ANALYZE_LOCAL`          | `0`                     | `1`: run each analysis as a local `node dist/worker` child process          |
| `ANALYZE_MAX_RETRIES`    | `2`                     | Must equal the job's `--max-retries`, so the worker knows its last attempt  |
| `QUOTA_LIMIT`            | `3`                     | Analyses per rolling 7-day window                                           |
| `GEMINI_MODEL`           | `gemini-3.6-flash`      | Model id                                                                    |
| `GEMINI_LOCATION`        | `global`                | Vertex serving location                                                     |
| `WORKER_JOB_ID`          | —                       | Worker only: set per execution by the dispatcher                            |
| `CLOUD_RUN_TASK_ATTEMPT` | `0`                     | Worker only: set by Cloud Run on each attempt                               |

## Local development

```bash
gcloud auth application-default login   # once; the account needs Vertex AI User
npm install
# .env.local: MONGODB_URI, BETTER_AUTH_SECRET, ANALYZE_LOCAL=1, STORAGE_KEY_FILE
npm run start:dev                        # keeps dist/ built, which the local worker process runs
```

With `ANALYZE_LOCAL=1` each analysis runs `node dist/worker` as a child process, the same entry point Cloud Run runs.
Vertex reads the real `gs://` object, so a real bucket and ADC are needed for the analysis step.

## Tests

```bash
npm test          # unit: quota, job lifecycle, pipeline, verification (real MongoDB via mongodb-memory-server)
npm run test:e2e  # Supertest against the Nest app with fake storage, prober, dispatcher and auth
npm run test:auth # after a build: sign-up, verification, reset and deletion against the real Better Auth
```

The unit tests run the Mongo-dependent logic against a real in-memory MongoDB, because the guarantees that matter
(conditional transitions, concurrent charges, at-most-once refunds) live in query semantics that mocks can't prove.

## Deployment

[`infra/setup.sh`](infra/setup.sh) (gcloud; Pulumi deliberately skipped, see [DECISIONS.md](DECISIONS.md)) enables the
APIs, applies the bucket CORS policy from [`infra/cors.json`](infra/cors.json), sets up the runtime service account and
secrets, deploys the `adlens-analyze` job (`node dist/worker`, 2 retries, 15-minute timeout) and the `adlens-api`
service. The API is served at `https://api.useadlens.com` through a Cloud Run domain mapping.

## Decisions

See [DECISIONS.md](DECISIONS.md). The two worth calling out:

- **Sizing the architecture to the load.** Analysis was first a BullMQ worker on Redis, an always-on service idle
  99% of the time for a product with a few runs per week. It became an on-demand Cloud Run Job: no idle cost, per-run
  isolation, retries and a hard timeout.
- **Correctness by construction.** A job's status has one owner and every transition is a guarded atomic update, so
  the failure modes of an asynchronous pipeline (double submits, crashed or retried workers, lost dispatches) end in a
  defined state with the quota refunded exactly once, and tests prove it against a real MongoDB.
