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
     or network problem (503) puts the job back to `pending` and never deletes the user's file. A job on a
     [sample ad](#sample-ads) skips this step: its video was measured when the sample was published;
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

**Admins have no limit**: set `isAdmin: true` on the user's document in Better Auth's `user` collection. Their runs
are still counted but never capped, and `GET /v1/me/quota` reports `limit: null`. The field is declared to Better Auth
with `input: false`, so sign-up and profile updates can't set it.

## Authentication

[Better Auth](src/auth/auth.instance.ts) on the app's own Mongo connection: email and password, plus Google and GitHub:

- **Sessions are httpOnly, `SameSite=Lax` cookies.** The web app (`www.useadlens.com`) and the API (`api.useadlens.com`)
  share the parent domain (`COOKIE_DOMAIN`), so the cookie is first-party for both and no token ever sits in
  JavaScript-readable storage. Socket.IO authenticates its handshake with the same cookie.
- **Email verification is required** before the first sign-in; signing in unverified resends the link.
- **Google and GitHub sign-in** (OAuth, callbacks on this API: `/api/auth/callback/{google,github}`). A provider is
  on when both its client id and secret are set; half a pair stops the API at startup. A social sign-in links to an
  existing user with the same email only when the provider reports that email as verified **and** the user's own
  email is verified, so an unconfirmed sign-up can't be taken over. Google always shows its account picker.
- **Password reset** by emailed link (1-hour token); a reset revokes every existing session.
- **Emailed links open the web app** (`/confirm-email`, `/reset-password`), never the API: users only see the site's
  domain, and the confirmation page calls `verify-email` from the browser once it loads, so mail scanners that fetch
  links without running JavaScript can't use the token up. Confirming signs the user in (Better Auth sets the session
  cookie on that response).
- **Account deletion** (password-confirmed, or within a day of signing in for users without a password) purges the
  user's jobs, quota and every uploaded object before Better Auth removes the account.
- **An email that can't be sent fails the request.** Emails go through Resend from `mail.useadlens.com`. Better Auth
  runs its email callbacks in a way that only logs their errors, so the callbacks queue each message for the request
  and an `after` hook sends it: a failed send answers 503 `EMAIL_NOT_SENT` instead of a success the user would wait on
  forever. The cost is that a password-reset request for an existing address takes a Resend round trip longer than one
  for an unknown address. Rate limits are stored in MongoDB so they hold across instances.

## API

Every `/v1/*` route except `GET /v1/samples` and `POST /v1/contact` requires a session; [`SessionGuard`](src/auth/session.guard.ts) resolves the user from the Better Auth
session cookie (never from the body) and every query is scoped by it. Errors share one shape,
`{ statusCode, errorCode, message, issues? }`, with `errorCode` from `adlens-shared`.

| Method & path               | Purpose                                                         | Returns                        |
| --------------------------- | --------------------------------------------------------------- | ------------------------------ |
| `ALL /api/auth/*`           | Better Auth (public)                                            | Better Auth                    |
| `GET /health`               | Liveness (public)                                               | `{ status, service, time }`    |
| `POST /v1/jobs`             | Create a pending job and its signed upload target               | `{ job, upload }`              |
| `POST /v1/jobs/from-sample` | Create a pending job on a published sample ad (no upload)       | `{ job }`                      |
| `POST /v1/jobs/:id/analyze` | Verify → charge → dispatch                                      | **202** `{ job }`              |
| `GET /v1/jobs`              | The caller's jobs, newest first (`?limit=` ≤ 50, `?cursor=`)    | `{ jobs, nextCursor }`         |
| `GET /v1/jobs/:id`          | One owned job                                                   | `{ job }`                      |
| `GET /v1/jobs/:id/video`    | A 15-minute signed URL for replaying the verified upload        | `{ url, expiresAt }`           |
| `DELETE /v1/jobs/:id`      | Delete a finished or unstarted job and its uploaded video (409 `JOB_IN_PROGRESS` while it runs) | **204**                        |
| `GET /v1/me/quota`          | The caller's quota window                                       | `{ quota }`                    |
| `POST /v1/contact`          | Email a Contact form message to the team (public, rate-limited) | **204**                        |
| `GET /v1/samples`           | Published sample ads with preview URLs (public)                 | `{ samples }`                  |

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

## Sample ads

Sample ads let anyone try AdLens without an ad of their own. Each is a document in the `samples` collection (title,
description, storage path, media facts, suggested settings, display order, published flag), and its video is stored
under `samples/` in the uploads bucket. `GET /v1/samples` lists them with short-lived preview URLs; the web app fills
in the suggested settings, which the user can change, and `POST /v1/jobs/from-sample` creates a job that points at the
sample's video. Analyzing it skips upload verification (the video was measured when it was published); the only check
is that a published sample still points at that object. It is charged like any other analysis.

Publish or update a sample from a manifest (the `video` path is relative to the manifest):

```json
{
    "slug": "running-shoes",
    "title": "Running shoes",
    "description": "A 15-second product spot with a spoken offer",
    "video": "running-shoes.mp4",
    "settings": { "platforms": ["YouTube"], "placements": ["youtube_shorts"], "markets": ["US"] },
    "order": 1
}
```

```bash
npm run samples:publish -- path/to/running-shoes.json --dry-run   # validate and measure only
npm run samples:publish -- path/to/running-shoes.json             # upload to samples/ and upsert by slug
```

Set `"isPublished": false` and publish again to hide a sample.

## Layout

```
src/        main.ts (API) and worker.ts (analysis worker), one Nest module per feature: jobs, analysis, rules, quota,
            auth, account, mail, storage, realtime, database, config
test/       e2e (Supertest) and auth-flow tests
scripts/    ruleset publishing, dependency guard
infra/      gcloud setup script and bucket CORS policy
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
| `RESEND_API_KEY`         | required by the API     | Resend sending key; the API won't start without it                          |
| `CONTACT_EMAIL`          | —                       | Where Contact form messages go; unset, the form answers 503                 |
| `GOOGLE_CLIENT_ID`       | —                       | Google sign-in; enabled with `GOOGLE_CLIENT_SECRET` (both or neither)       |
| `GOOGLE_CLIENT_SECRET`   | —                       | Google OAuth client secret                                                  |
| `GITHUB_CLIENT_ID`       | —                       | GitHub sign-in; enabled with `GITHUB_CLIENT_SECRET` (both or neither)       |
| `GITHUB_CLIENT_SECRET`   | —                       | GitHub OAuth client secret                                                  |
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
# .env.local: MONGODB_URI, BETTER_AUTH_SECRET, RESEND_API_KEY, ANALYZE_LOCAL=1, STORAGE_KEY_FILE
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

Every push to `init-setup` that passes CI deploys to production
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The `deploy` job signs in to Google Cloud with Workload
Identity Federation: GitHub's OIDC token is exchanged for a short-lived credential, no service account key exists, and
only this repository's pushes to `init-setup` are accepted. It builds one image, pushes it to Artifact Registry, rolls
the `adlens-analyze` job and then the `adlens-api` service to that digest, and ends with a health check.

[`infra/setup.sh`](infra/setup.sh) (plain gcloud, see [Design decisions](#design-decisions)) creates
everything the workflow relies on: the APIs, the bucket and its CORS policy from [`infra/cors.json`](infra/cors.json),
the runtime and deploy service accounts, the Workload Identity provider, the secrets and the image repository. It also
owns the runtime config (env vars, secrets, the job's 2 retries and 15-minute timeout), which CI leaves untouched, and
can deploy the current checkout by hand. The API is served at `https://api.useadlens.com` through a Cloud Run domain
mapping.

## Design decisions

Why the system is built this way, and what was rejected. Decisions that span the three repos are recorded here.

**Architecture**

- **Analysis runs as an on-demand Cloud Run Job.** It started as a BullMQ worker on Redis: an always-on service idle
  over 99% of the time at a few analyses a week. A job costs nothing when idle and gives per-run isolation, retries and
  a hard timeout. Cloud Tasks pushing to a scale-to-zero service would also work; worker pools with an external
  autoscaler were more moving parts for no gain at this load.
- **One image, two entry points.** The API (`dist/main`) and the worker (`dist/worker`) share code and an image but have
  separate composition roots, so the worker has no HTTP layer and can't start another worker.
- **MongoDB (Atlas) over Postgres.** A job is one nested document (settings, media facts, analysis), and Change Streams
  give realtime updates without a separate broker. They need a replica set, which Atlas provides (and Better Auth needs
  for transactions).
- **Realtime through Socket.IO fed by a Change Stream**, one watcher per API instance. Running several instances
  behind a load balancer would need a shared Socket.IO adapter.
- **Gemini on Vertex AI with Application Default Credentials**, so no API key exists. Gemini 3 models are served from
  the `global` location.

**Correctness**

- **One owner for job status.** `JobLifecycle` performs every transition as a conditional update on the expected
  current status. Status written from several places allowed double charges and dispatches, regressions from
  `analyzing` to `queued`, and jobs stuck in progress after a crashed worker.
- **Charge when queued, refund at most once.** The atomic charge is the gate; charging only after success would let
  concurrent requests pass a non-consuming check. The job stores the window it was charged to, and the write that ends
  a run clears it, so exactly one caller refunds, into the window the charge came from.
- **Attempt-aware retries.** Cloud Run retries any non-zero exit, so the worker reads its attempt number: transient
  failures exit 1 while attempts remain; permanent ones, or the last attempt, end the job. Malformed or truncated model
  output counts as transient because generation is stochastic, and `maxOutputTokens` caps what an attempt can cost.
- **Gemini 3 runs at its default temperature.** Google advises keeping Gemini 3 at 1.0; a temperature of 0.2 made it
  loop into an 18k-token malformed reply in testing.
- **Verification trusts the stored object, not the client.** Size and type come from object metadata and ffprobe, and
  the signed upload URL binds the exact declared size. Only a definite problem with the file deletes it; storage or
  network trouble leaves the job pending.
- **Lazy expiry instead of a scheduler.** Abandoned jobs are expired when their owner next reads their jobs, which
  needs no Cloud Scheduler.
- **Tests run against a real MongoDB** (`mongodb-memory-server`), because the guarantees above live in query semantics
  that mocks can't prove. Auth flows run against the real Better Auth, which Jest can't load (ESM), under Node's test
  runner.

**Contract and rules**

- **The contract package holds only the contract.** `adlens-shared` publishes request, response and public job
  schemas. The stored job is composed here from those blocks plus server-only fields (owner, storage path, execution,
  accounting), so they never reach a client. It is published by CI and pinned exactly, because a `file:` link only
  works on one machine.
- **Rulesets are immutable, versioned data in MongoDB.** `npm run rules:publish` validates with the worker's own
  schema and refuses an existing version, so a rules change needs no deploy and every analysis records its
  `rulesetVersion`. A script was chosen over an admin endpoint, which would need an admin identity model.
- **Rules target placements and markets, not just platforms.** Format caps such as the 6-second bumper apply only to
  their placement, and UK/EU/US rules only in their market; a test proves every rule is reachable.

**Auth and hosting**

- **Same-site session cookies instead of bearer tokens.** The web app and the API share `useadlens.com`, so Better
  Auth's httpOnly cookie is first-party for both and no token sits in JavaScript-readable storage. `*.vercel.app` and
  `*.run.app` are on the Public Suffix List, so this needs an own domain. Emails are sent from the `mail.` subdomain to
  keep its sending reputation separate.
- **Keyless deploys, one image per commit.** GitHub Actions authenticates through Workload Identity Federation, limited
  to this repository's `init-setup` branch by numeric ids, so no long-lived key exists. The worker job and the API are
  rolled to the same digest, the job first. CI only swaps the image; runtime config stays in `infra/setup.sh`.
- **Infrastructure as a gcloud script.** The infrastructure is a handful of set-once resources, so an idempotent,
  committed script is enough; Terraform or Pulumi would be the step up if it grows.
