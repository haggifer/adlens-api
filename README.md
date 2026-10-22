# adlens-api

> Part of **[AdLens](https://github.com/haggifer/adlens)**, AI policy checks for video ads · [Live](https://www.useadlens.com)

[![CI](https://github.com/haggifer/adlens-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/haggifer/adlens-api/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)

The AdLens backend. An uploaded video ad is verified, checked against an ad-policy ruleset of several hundred rules in
one Gemini pass, and returned as cited, timestamped findings, with each step announced to the browser as it happens.
This repo holds the HTTP API, the analysis worker, the daily cleanup and the database job.

## Getting started

```bash
gcloud auth application-default login   # once; the account needs Vertex AI User
npm install
# .env.local: MONGODB_URI, BETTER_AUTH_SECRET, RESEND_API_KEY, CONTACT_EMAIL, ANALYZE_LOCAL=1, STORAGE_KEY_FILE, TURNSTILE_SECRET_KEY
npm run start:dev                        # keeps dist/ built, which the local worker process runs
```

With `ANALYZE_LOCAL=1` each analysis runs `node dist/worker` as a child process, the same entry point Cloud Run runs.
Vertex reads the real `gs://` object, so a real bucket and ADC are needed for the analysis step. The watch mode polls
files and ignores `node_modules` (on Windows a dependency read looks like a change and would kill the worker), so
restart `npm run start:dev` yourself after `npm install`.

Locally, use Cloudflare's test secret 1x0000000000000000000000000000000AA (always passes) with the web's test site
key; 2x0000000000000000000000000000000AA always fails.

```bash
npm test          # unit: quota, network quota, Contact limits, job lifecycle, pipeline, verification, client IP, indexes and migrations (real MongoDB via mongodb-memory-server)
npm run test:e2e  # Supertest against the Nest app with fake storage, prober, dispatcher and auth
npm run test:auth # after a build: sign-up, verification, reset, deletion, anonymous linking and rate limits against the real Better Auth
npm run knip      # unused files, exports and dependencies (also in CI)
```

`knip.json` lists the four entry points (`main.ts`, `worker.ts`, `cleanup.ts`, `db.ts`); add any new one there. It
also lists the e2e and auth-flow tests itself, with Knip's Node.js plugin off, since that plugin took every `test-*`
file for a test entry and hid unused exports in test helpers.

## Architecture

```
 Browser (Next.js on Vercel) ◄── Ably: "presets" / "job" on user:<id>, published by the API, worker and cleanup
   │  REST /v1/*  ·  /api/auth/*  ·  token for Ably               signed PUT (exact type + size)
   ▼                                                                   │
 ┌──────────────────────────────┐      runJob(WORKER_JOB_ID)      ┌────▼──────────────┐
 │ Cloud Run service: adlens-api │ ─────────────────────────────►  │ GCS uploads bucket │
 │ node dist/main               │                                  └────▲──────────────┘
 │ · Better Auth · verification │   ┌──────────────────────────────┐    │ gs:// URI
 │ · quota · job lifecycle      │   │ Cloud Run Job: adlens-analyze │    │
 └──────┬───────────────────────┘   │ node dist/worker (on demand)  │────┘
        │ Mongoose                  │ · rules · Gemini on Vertex    │
        ▼                           └──────────────┬───────────────┘
      MongoDB Atlas       (jobs, ip_quotas, Better Auth collections) ◄┘
```

- **API** (`src/main.ts` → `AppModule`): NestJS 11 on Cloud Run at `api.useadlens.com`. Better Auth, Mongoose on Atlas,
  GCS signed URLs, ffprobe verification, quota, live update tokens.
- **Worker** (`src/worker.ts` → `WorkerModule`): the same image run as an **on-demand Cloud Run Job**. The API starts
  one execution per upload job at its creation (one per user at a time) and one per start not left to that worker,
  such as a sample's or a restart's. The worker analyzes its job at most once and exits; with no HTTP layer and no
  dispatcher, it can never start another worker.
- **Cleanup** (`src/cleanup.ts` → `CleanupModule`): the same image, run daily at 03:00 UTC by Cloud Scheduler as the
  `adlens-cleanup` job. It expires abandoned jobs and ends those still `pending` after 6 hours as `UPLOAD_FAILED`,
  deletes anonymous users unused for a week, deletes the video of every job that backs no results
  ([`AbandonedUploadCleanupService`](src/cleanup/abandoned-upload-cleanup.service.ts)) and every path a deleted job's
  still-valid upload URL could have filled
  ([`UploadTombstoneCleanupService`](src/cleanup/upload-tombstone-cleanup.service.ts)), and retries the refunds ended
  jobs still owe. Analyzed jobs and samples keep their videos. A step that fails is logged and the run goes on; any
  failure exits 1.
- **Database job** (`src/db.ts` → `DbJobModule`): the same image, run by the deploy as the `adlens-db` job once the API
  is healthy. It applies pending data migrations ([`migrations.ts`](src/db-job/migrations.ts)), creates the indexes the
  models and [`AUTH_INDEXES`](src/auth/auth-indexes.ts) declare ([`syncIndexes`](src/db-job/index-sync.ts); one nobody
  declares is only reported), and syncs each collection's `$jsonSchema` validator, generated from its Zod schema
  ([`syncValidators`](src/db-job/validators.ts)), in warn mode with a count of the documents it refuses. Without
  `--apply` it only logs what it would do.
- **Logs**: on Cloud Run (`LOG_FORMAT=json`) every process writes one JSON object per line through
  [`CloudLogger`](src/common/cloud-logger.ts), with the `severity` Logs Explorer filters on and the `stack_trace` Error
  Reporting groups. Locally the default is Nest's readable text.
- **Live updates** ([`LivePublisher`](src/live/live-publisher.ts)): every write to a user's presets or to a job's status
  tells that user's tabs through [Ably](https://ably.com) on `user:<id>` (`presets`, or `job` with the job's id). The
  message carries no data; tabs refetch through the API. A publish times out after 2 seconds, never fails the write,
  and pauses publishing for a minute when it fails. `GET /v1/live/token` signs a token for the caller's own channel;
  without `ABLY_API_KEY` nothing is published and tabs rely on their reads.
- **Contract**: every request body, response and error has a Zod schema in `adlens-shared`. The API returns the
  public job shape only; owner, storage paths, execution names and accounting stay server-side.

## Job lifecycle

`pending → verifying → queued → analyzing → analyzed | error`

[`JobLifecycle`](src/jobs/job-lifecycle.service.ts) is the single owner of a job's status. Every transition is one
conditional update on the expected current status, so two racing callers can never both win (a double-clicked
"analyze" can't verify, charge or dispatch twice).

1. **Create** `POST /v1/jobs`: a `pending` job and a V4 signed PUT URL bound to the declared type and **exact size**,
   which can only create the object, so a verified video can't be replaced. The [admission check](#abuse-limits) runs
   first, read-only. The job's worker is dispatched alongside the signing (capped at 4 s), so Cloud Run provisions it
   (about 24 s) while the browser uploads; it waits up to 3 minutes for the run to start (`workerWaitsUntil`). A user
   gets one such early worker at a time; sample jobs and restarts get their worker at start.
2. **Start** `POST /v1/jobs/:id/analyze` ([`JobAnalysisService`](src/jobs/job-analysis.service.ts)). A step that fails
   ends the job in `error`, with any charge refunded; a job never goes back to `pending`.
    - **claim** `pending → verifying` (409 `JOB_NOT_PENDING` for a second caller);
    - **verify** ([`VideoVerifier`](src/jobs/verification/video-verifier.service.ts)) from the stored object's metadata
      plus ffprobe over a signed read URL (range reads; the image runs Debian's ffprobe, because `ffprobe-static`'s
      Linux build segfaults on hostname lookups). A bad file is rejected with 422 and deleted; a missing upload ends
      the job as `UPLOAD_FAILED`, storage trouble as `VIDEO_CHECK_FAILED`. A [sample](#samples-and-demos) skips it;
    - **charge** one run on the user's network, then one on the user, and move to `queued` (429 `QUOTA_EXCEEDED`,
      `SIGN_UP_REQUIRED` or `EMAIL_CONFIRMATION_REQUIRED`; the network rules answer with their own codes). A failed user
      charge gives the network run back;
    - **dispatch** the worker, unless the write that queued the job left it to the early worker (`leftToEarlyWorker`,
      when its deadline is over 15 s away). A failed dispatch ends the job as `ANALYSIS_FAILED`, refunded (503).

    **Restart** `POST /v1/jobs/:id/restart` runs a failed analysis again on its stored video, as a new job: the owner's
    `error` job, not restarted yet, under 6 hours old (`isJobRestartable`), its video still stored, and within quota;
    otherwise 409 `JOB_NOT_RESTARTABLE`. The failed job is claimed with one conditional write (`restartedAs`) and stays
    as the record of its run, left out of lists. The cleanup and deletions claim a video before deleting it, so nothing
    deletes the video under a restart.

3. **Analyze** ([`AnalysisPipeline`](src/analysis/pipeline/analysis-pipeline.service.ts)). An early worker first polls
   the job ([`EarlyWorkerWait`](src/analysis/pipeline/early-worker-wait.ts)) and runs it only when it was left to it;
   otherwise it exits 0, so two workers never run one job. Then `queued → analyzing`, select the rules, check the
   metadata rules in code, run one Gemini pass through [`VideoReviewer`](src/analysis/review/video-reviewer.ts), and
   `analyzing → analyzed`. The Gemini request, reading its answer and the assembly need neither Nest nor the database,
   so an evaluation tool outside this repo runs the same code through [`src/lab.ts`](src/lab.ts), a barrel listed as a
   knip entry and left out of the build.
4. **Fail well**: a transient failure exits 1 so Cloud Run retries it, unless the call may have been billed; a
   permanent one, or the last attempt, ends the job (`MODEL_UNAVAILABLE` when Gemini failed, `ANALYSIS_FAILED`
   otherwise). The worker marks the job (`modelCallStartedAt`) before calling Gemini, and only a call Vertex refused
   with an HTTP error status clears the mark, so a job is never billed twice. The call times out after 10 minutes,
   inside the 15-minute task timeout.
5. **Nothing stays in flight forever**: on every read of a user's jobs and in the daily cleanup, stuck jobs are expired
   with a conditional update: `verifying` after 10 minutes as `VIDEO_CHECK_FAILED`; `queued` or `analyzing` as
   `ANALYSIS_TIMED_OUT`, refunded, 5 minutes after `queuedAt` while the Gemini call hasn't started and 12 minutes after
   it started (longer than its timeout, so a live worker settles first); `pending` after 6 hours as `UPLOAD_FAILED`.

**Quota** ([`QuotaService`](src/quota/quota.service.ts)): `QUOTA_LIMIT` analyses per rolling 7-day window for a
confirmed account. Before the email is confirmed a user gets one analysis in total, for good (`freeRunId` on the user
document, which moves with the runs when an anonymous user signs up or in). The `adlens_free_run` cookie (httpOnly,
400 days) marks the browser that used it, so signing out and starting over gets no second one; clearing cookies does,
bounded by `IP_ANON_LIMIT`.

Each charged run is stored on the user's Better Auth document (`runs: { id, startedAt, jobId }[]`) and stops counting
7 days after it started (`nextFreeAt` in `GET /v1/me/quota`). A charge is one conditional pipeline update, so concurrent
requests can't overdraw. The job records its run (`chargedRunId`) before the charge and keeps it until the refund
(`$pull`, safe to repeat) succeeds; a failed refund is retried on every read of the user's jobs and in the cleanup.
Deleting a job keeps its run counted.

**Admins have no limit**: set `isAdmin: true` on the user's document in Better Auth's `user` collection. Their runs are
counted but never capped (`limit: null`); the field is declared with `input: false`, so sign-up can't set it.

## Abuse limits

Anyone can analyze without signing up, so free runs are bounded per network as well as per user. An account that
hasn't confirmed its email ([`getUserAccess`](src/common/user-access.ts)) meets every rule of an anonymous user and is
asked to confirm (`EMAIL_CONFIRMATION_REQUIRED`) where an anonymous user is asked to sign up (`SIGN_UP_REQUIRED`):

| Rule                                                 | Limit per rolling 7 days      | When hit                                                                                   |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| Per confirmed account                                | `QUOTA_LIMIT` (5, in `.env`)  | 429 `QUOTA_EXCEEDED`                                                                       |
| Per user before the email is confirmed, for good     | 1 (`PROVISIONAL_QUOTA_LIMIT`) | 429 `SIGN_UP_REQUIRED` / `EMAIL_CONFIRMATION_REQUIRED`                                     |
| Anonymous users and unconfirmed accounts per network | `IP_ANON_LIMIT` (3) in total  | 429 `SIGN_UP_REQUIRED` / `EMAIL_CONFIRMATION_REQUIRED`                                     |
| Everyone per network, soft                           | `IP_SOFT_LIMIT` (10)          | a Turnstile check for each further analysis: 403 `CHALLENGE_REQUIRED` / `CHALLENGE_FAILED` |
| Everyone per network, hard                           | `IP_HARD_LIMIT` (30)          | 429 `NETWORK_QUOTA_EXCEEDED`                                                               |

- **The network** is the IPv4 address or the IPv6 /64, taken from the `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS` from
  the right ([`ClientNetworkResolver`](src/ip-quota/client-network.resolver.ts)), never the leftmost one, which the
  client controls.
- **Storage** ([`IpQuotaService`](src/ip-quota/ip-quota.service.ts)): one `ip_quotas` document per network, keyed by an
  HMAC of it (key derived from `BETTER_AUTH_SECRET` with HKDF), holding its runs and a TTL 7 days after the last
  charge. The address itself is never stored or logged.
- **Order** ([`AnalysisAdmission`](src/jobs/analysis-admission.service.ts)): job creation checks the user cap and the
  network rules read-only; analyze charges the network, then the user. The job records both run ids before charging,
  so each is refunded at most once and never lost.
- **Early workers**: one at a time per user, since creating a job spends nothing yet dispatches a billed execution.
- **Failed analyses**: a run that ends without a result is never counted; every failure refunds both runs. Gemini is
  still called at most once per job, and an answer that can't be used (cut off, blocked, malformed) is never retried,
  since it was billed.
- **Turnstile** ([`ChallengeVerifier`](src/challenge/challenge-verifier.ts)): Cloudflare's `siteverify` is called only
  when a rule asks for it, always for anonymous users and unconfirmed accounts; members send a token only after a
  `CHALLENGE_REQUIRED`. Without `TURNSTILE_SECRET_KEY` a required check never passes.
- **Admins** (`isAdmin: true`) skip every network rule.

## Contact form

`POST /v1/contact` is public. The message (at most 2,000 characters) goes to `CONTACT_EMAIL` through Resend with the
visitor as Reply-To, so answering is a plain reply; its text isn't stored.

- **The email is built for a support inbox** ([`contact-email.ts`](src/contact/contact-email.ts)): the sender's address
  as sender name, a subject of `[AdLens] <first line> · ref <ref>`, the message first, then the sender's account, recent
  analyses, browser and the API revision. The IP address is never included.
- **Honeypot**: a hidden `website` field; a message that fills it in answers 204 and sends nothing.
- **Turnstile**: a message carries a `challengeToken` or the `draftId` of its images, checked before anything is
  counted.
- **Images**: up to 5 PNG, JPEG or WebP images, 8 MB each and 25 MB together. `POST /v1/contact/uploads` checks a token
  and answers one signed, create-only upload per image under a one-use draft that lives an hour; sending marks the
  draft used in one conditional update and checks every object's size and type first. Images are deleted after 30
  days ([`infra/lifecycle.json`](infra/lifecycle.json)).
- **Hourly caps** ([`ContactLimits`](src/contact/contact-limits.ts)): 3 messages per network, 3 per sender email, 20 in
  total and 3 upload drafts per network, then 429 `RATE_LIMITED`. Counters are keyed by an HMAC, never the address,
  and the narrowest cap is counted first, so a refused message doesn't use up the total.

## Authentication

[Better Auth](src/auth/auth.instance.ts) on the app's own Mongo connection: email and password, plus Google and GitHub.

- **Sessions are httpOnly, `SameSite=Lax` cookies** shared by `www.useadlens.com` and `api.useadlens.com` through
  `COOKIE_DOMAIN`, so no token sits in JavaScript-readable storage. The API's own session reads never refresh a session.
- **Anonymous sessions** (Better Auth's `anonymous` plugin) start right before a visitor's first analysis or preset save,
  never on page load, as a real `user` document, so everything works unchanged. Signing up or in moves their jobs,
  quota runs and presets to the account ([`AccountDataService.adopt`](src/account/account-data.service.ts)), then
  deletes the anonymous user. `/link-social` is refused for anonymous and unconfirmed sessions.
- **Abandoned anonymous users are deleted after a week**: a session hook stamps `lastSeenAt`, and the daily cleanup
  ([`AnonymousCleanupService`](src/cleanup/anonymous-cleanup.service.ts)) purges each one unseen for 7 days with no
  live session.
- **Disposable email domains are refused at sign-up** (`DISPOSABLE_EMAIL`).
- **One confirmed account per mailbox** ([`email-alias.ts`](src/auth/email-alias.ts)): a sign-up or confirmation whose
  address reaches a confirmed account's mailbox (`+tags`, Gmail dots, `googlemail.com`) answers
  `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, so aliases can't stack allowances. The first account to confirm keeps it.
- **Unconfirmed accounts sign in** straight away and are limited like an anonymous user until they confirm (the link is
  valid 24 hours), but are never deleted for inactivity.
- **Google and GitHub sign-in** is on when a provider's client id and secret are both set. A social sign-in links to an
  existing user only when both the provider's and the user's email are verified. Provider tokens are never stored.
- **Password reset** by emailed link (1 hour); a reset revokes every session.
- **Emailed links open the web app**, which calls `verify-email` once loaded, so mail scanners can't use a token up.
  Only the account's own session confirms it (401 `SIGN_IN_REQUIRED`, 403 `EMAIL_MISMATCH` otherwise), and confirming
  creates no session.
- **Auth error codes** of AdLens's own that Better Auth answers are in [`auth-error-codes.ts`](src/auth/auth-error-codes.ts).
- **Account deletion** purges the user's jobs, presets and every uploaded object, adopted ones included, before Better
  Auth removes the account.
- **An email that can't be sent fails the request** with 503 `EMAIL_NOT_SENT`: Better Auth only logs its email
  callbacks' errors, so the callbacks queue each message and an `after` hook sends it.
- **At most 5 confirmation and 5 reset emails per address per hour**, counted under a keyed hash; past the cap nothing
  is sent and the answer is unchanged.
- **Better Auth's rate limits** (its defaults, plus 10 anonymous sign-ins an hour per client) are counted in MongoDB
  ([`createRateLimitStorage`](src/auth/rate-limit-storage.ts)), keyed by an HMAC, so they hold across instances.
- **Sessions don't store the IP address**; a session hook clears it.
- **Better Auth's collections are indexed by the database job** ([`AUTH_INDEXES`](src/auth/auth-indexes.ts)), since its
  adapter creates no indexes, and no process changes the database structure on start (`autoIndex` and `autoCreate` off).

## API

Every `/v1/*` route requires a session except `GET /v1/samples`, `GET /v1/demos`, `GET /v1/admission` and the contact
routes. [`SessionGuard`](src/auth/session.guard.ts) resolves the user from the session cookie, never the body, and every
query is scoped by it; `/v1/admin/*` takes [`AdminGuard`](src/admin/admin.guard.ts), which answers anyone but an admin
with the 404 of a route that doesn't exist. Errors share one shape, `{ statusCode, errorCode, message, issues? }`, with
`errorCode` from `adlens-shared`. JSON bodies are capped at 1 MB and Better Auth's at 64 KB (413 `VALIDATION_FAILED`).

| Method & path               | Purpose                                                                                                                                                                                                                                | Returns                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ALL /api/auth/*`           | Better Auth (public)                                                                                                                                                                                                                   | Better Auth                                          |
| `GET /health`               | Liveness (public)                                                                                                                                                                                                                      | `{ status, service, time }`                          |
| `POST /v1/jobs`             | Admission check (optional challengeToken), then a pending job and its signed upload target                                                                                                                                             | `{ job, upload }`                                    |
| `POST /v1/jobs/from-sample` | Admission check, then a pending job on a published sample ad (no upload)                                                                                                                                                               | `{ job }`                                            |
| `POST /v1/jobs/:id/analyze` | Verify → charge network and user → dispatch → once the worker started, count the run for its `presetId` when the settings still match it (counted whatever the run's outcome; never fails the start)                                   | **202** `{ job }`                                    |
| `POST /v1/jobs/:id/restart` | A failed analysis again, as a new job on its stored video (see the run flow); 409 `JOB_NOT_RESTARTABLE` when it can't be                                                                                                               | **202** `{ job }` (the new job)                      |
| `GET /v1/jobs`              | The caller's jobs, newest first, restarted ones left out (`?limit=` ≤ 50, `?cursor=`)                                                                                                                                                  | `{ jobs, nextCursor }`                               |
| `GET /v1/jobs/:id`          | One owned job                                                                                                                                                                                                                          | `{ job }`                                            |
| `GET /v1/jobs/:id/video`    | A 2-hour signed URL for replaying the verified upload (404 `NOT_FOUND` once the cleanup deleted it)                                                                                                                                    | `{ url, expiresAt }`                                 |
| `DELETE /v1/jobs/:id`       | Delete a finished or unstarted job and its uploaded video (409 `JOB_IN_PROGRESS` while it runs)                                                                                                                                        | **204**                                              |
| `GET /v1/me/quota`          | The caller's quota window                                                                                                                                                                                                              | `{ quota }`                                          |
| `GET /v1/live/token`        | A signed Ably token request that may only subscribe to the caller's channel (`user:<id>`); `null` when live updates are off                                                                                                            | `{ tokenRequest }`                                   |
| `GET /v1/presets`           | The caller's saved analysis presets (at most 20), default flag and usage included. Every preset route allows a user 300 reads and 60 writes a minute ([`PresetLimits`](src/presets/preset-limits.ts)), then answers 429 `RATE_LIMITED` | `{ presets }`                                        |
| `POST /v1/presets`          | Save a preset. A taken name (ignoring case, inner whitespace and Unicode compatibility forms: `toNameKey`) is `409 PRESET_NAME_TAKEN` unless `overwrite: true`; a 21st is `409 PRESET_LIMIT_REACHED`                                   | **201** `{ preset }` (**200** when it overwrote one) |
| `PUT /v1/presets/:id`       | Edit a preset's name and settings (same refusals, `404 NOT_FOUND` for an unknown id)                                                                                                                                                   | `{ preset }`                                         |
| `PUT /v1/presets/default`   | Make a preset the default, or `{ presetId: null }` to clear it                                                                                                                                                                         | **204**                                              |
| `DELETE /v1/presets/:id`    | Delete a preset (`404 NOT_FOUND` when it is gone)                                                                                                                                                                                      | **204**                                              |
| `GET /v1/admission`         | Whether a new analysis would be admitted (public; a visitor without a session is judged as a new anonymous user): the same quota and network refusals as `POST /v1/jobs`, without charging or the Turnstile check                      | **204**, or the refusal                              |
| `POST /v1/contact/uploads`  | Signed uploads for a Contact form message's images (public, Turnstile-checked, rate-limited)                                                                                                                                           | **201** `{ draftId, uploads }`                       |
| `POST /v1/contact`          | Email a Contact form message to the team (public, Turnstile-checked or with an upload draft, rate-limited)                                                                                                                             | **204**                                              |
| `GET /v1/samples`           | Published sample ads with preview URLs (public)                                                                                                                                                                                        | `{ samples }`                                        |
| `GET /v1/demos`             | Active, finished demo analyses with their summary and a video URL (public)                                                                                                                                                             | `{ demos }`                                          |
| `GET /v1/admin/jobs`        | Every job, newest first, with its owner, file name, sample title and each recorded Gemini call (admins only; raw records, the admin page derives costs)                                                                                | `{ jobs }`                                           |
| `GET /v1/admin/users`       | Every user, newest first, with their access flags; an anonymous user's email is `null` (admins only)                                                                                                                                   | `{ users }`                                          |

## Ad-policy rules

Rules are data: a ruleset authored outside this repo in the shape of [`ruleSetSchema`](src/rules/schema.ts) and
published to MongoDB as an **immutable version**, validated by the schema the worker parses it with. The worker serves
the newest version ([`RulesetService`](src/rules/ruleset.service.ts)), so a rules update needs no redeploy.

Selection ([`src/rules/index.ts`](src/rules/index.ts)) follows the job's **platforms** (YouTube also pulls in Google Ads
policy), **markets** (global rules always; UK/EU/US rules only in their market) and **placements**; an empty setting
stands for every value. Selected rules are routed by `modality`:

- `metadata` → checked in code against the measured facts (duration with a 0.1 s tolerance, dimensions as displayed,
  aspect ratio, short-side resolution, size); each check says which placement the video won't work for, and why;
- `text` / `visual` / `audiovisual` → sent to the model as `{ id, check, severity, modality }`; quotes and source links
  are attached back by id, and ids the model invents are dropped;
- `out_of_creative` → an advisory checklist the model only picks from, never judges.

Every analysis records `model`, `promptVersion` and `rulesetVersion`, and the job keeps every billed Gemini call in
`usage.calls` (model, location, traffic type, tokens by kind and modality, `durationMs`), failed attempts included, for
pricing.

## Samples and demos

- **Sample ads** let anyone try AdLens without an ad of their own: documents in `samples` with a video in the public
  media bucket and suggested settings. `POST /v1/jobs/from-sample` creates a job on the sample's video, which skips
  upload verification and is charged like any analysis.
- **Demos** are finished analyses anyone can see on the demo page: ordinary jobs with a `demo` field, owned by `demo`
  (no user), so nobody's History lists them and the cleanup never deletes their videos. `GET /v1/demos` lists the
  latest analyzed job of each active demo.

The maintainer publishes both; setting `isPublished` or `isActive` to `false` and publishing again hides one.

## Structure

```
src/        main.ts (API), worker.ts (analysis worker), cleanup.ts (daily cleanup), db.ts (database job) and lab.ts
            (the evaluation tool's only import surface), one Nest module per feature: jobs,
            analysis, rules, samples, demos, presets, quota, me, ip-quota, challenge, auth, account, contact, cleanup, mail, storage,
            live, database, db-job, config; shared helpers in common/, test helpers in testing/
test/       e2e (Supertest) and auth-flow tests
infra/      gcloud setup script, bucket CORS policy and lifecycle rule, image repository cleanup policy
```

## Environment

All variables are validated at startup by [`src/config/env.ts`](src/config/env.ts); a missing or malformed value stops
the process with a readable error. Locally they come from `.env` (non-secret, committed, also shipped in the image) and
`.env.local` (secrets, never shipped); Cloud Run's env vars take precedence. In production, secrets come from one Secret
Manager secret, `API_SECRETS`, mounted as a JSON file (`SECRETS_FILE`) and merged into the config before validation.

| Variable                 | Default                                | Purpose                                                                                                                                               |
| ------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRETS_FILE`           | —                                      | Path to a mounted JSON file of secrets; unset locally. Its keys fill gaps in the environment, never override it                                       |
| `MONGODB_URI`            | required                               | Atlas connection string (Mongoose, Better Auth)                                                                                                       |
| `GOOGLE_CLOUD_PROJECT`   | required                               | GCP project for Vertex and Cloud Run                                                                                                                  |
| `STORAGE_BUCKET`         | required                               | The uploads bucket                                                                                                                                    |
| `PUBLIC_MEDIA_BUCKET`    | —                                      | Publicly readable bucket of demo and sample videos, served at their plain address; unset, they are signed                                             |
| `BETTER_AUTH_SECRET`     | required by the API                    | Better Auth signing secret                                                                                                                            |
| `BETTER_AUTH_URL`        | `http://localhost:8080`                | The API's own public URL                                                                                                                              |
| `WEB_ORIGIN`             | `http://localhost:3000`                | Web origin for CORS, Better Auth and email links; a `localhost` origin also allows the next 5 ports (a dev server that finds its port taken moves on) |
| `COOKIE_DOMAIN`          | —                                      | Parent domain for the session cookie in production (`useadlens.com`)                                                                                  |
| `RESEND_API_KEY`         | required by the API                    | Resend sending key; the API won't start without it                                                                                                    |
| `CONTACT_EMAIL`          | required by the API                    | Where Contact form messages go; the API won't start without it                                                                                        |
| `GOOGLE_CLIENT_ID`       | —                                      | Google sign-in; enabled with `GOOGLE_CLIENT_SECRET` (both or neither)                                                                                 |
| `GOOGLE_CLIENT_SECRET`   | —                                      | Google OAuth client secret                                                                                                                            |
| `GITHUB_CLIENT_ID`       | —                                      | GitHub sign-in; enabled with `GITHUB_CLIENT_SECRET` (both or neither)                                                                                 |
| `GITHUB_CLIENT_SECRET`   | —                                      | GitHub OAuth client secret                                                                                                                            |
| `MAIL_FROM`              | `AdLens <no-reply@mail.useadlens.com>` | Sender of auth emails                                                                                                                                 |
| `PORT`                   | `8080`                                 | API listen port                                                                                                                                       |
| `LOG_FORMAT`             | `text`                                 | `json` on Cloud Run: one Cloud Logging entry per line, with `severity`                                                                                |
| `STORAGE_KEY_FILE`       | —                                      | Local only: SA key used to sign V4 URLs (user ADC can't sign)                                                                                         |
| `GCP_REGION`             | `europe-west1`                         | Region of the analysis Cloud Run Job                                                                                                                  |
| `ANALYZE_JOB_NAME`       | `adlens-analyze`                       | The Cloud Run Job the API executes                                                                                                                    |
| `ANALYZE_LOCAL`          | `0`                                    | `1`: run each analysis as a local `node dist/worker` child process                                                                                    |
| `ANALYZE_MAX_RETRIES`    | `2`                                    | Must equal the job's `--max-retries`, so the worker knows its last attempt                                                                            |
| `QUOTA_LIMIT`            | — (required, `5` in `.env`)            | Analyses per rolling 7-day window for a confirmed account (before confirmation a user gets 1 in total)                                                |
| `IP_ANON_LIMIT`          | `3`                                    | Analyses by anonymous users and unconfirmed accounts per network in a rolling 7-day window                                                            |
| `IP_SOFT_LIMIT`          | `10`                                   | Analyses per network before everyone needs a Turnstile check                                                                                          |
| `IP_HARD_LIMIT`          | `30`                                   | Analyses per network, for everyone                                                                                                                    |
| `TRUSTED_PROXY_HOPS`     | `1`                                    | Proxies that append to `X-Forwarded-For` (1 on Cloud Run)                                                                                             |
| `TURNSTILE_SECRET_KEY`   | —                                      | Cloudflare Turnstile secret; unset, a required check never passes                                                                                     |
| `ABLY_API_KEY`           | —                                      | Ably key (publish and subscribe) for live updates; unset, nothing is published and tabs rely on their reads                                           |
| `GEMINI_MODEL`           | `gemini-3.8-flash`                     | Model id                                                                                                                                              |
| `GEMINI_LOCATION`        | `global`                               | Vertex serving location                                                                                                                               |
| `WORKER_JOB_ID`          | —                                      | Worker only: set per execution by the dispatcher                                                                                                      |
| `WORKER_IS_EARLY`        | `0`                                    | Worker only: `1` on the execution dispatched at an upload job's creation, which waits for the job to be queued                                        |
| `CLOUD_RUN_TASK_ATTEMPT` | `0`                                    | Worker only: set by Cloud Run on each attempt                                                                                                         |

## Deployment

Every push to `main` that passes CI deploys to production ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The
`deploy` job signs in to Google Cloud with Workload Identity Federation (no service account key exists), builds one
image, rolls the `adlens-analyze` and `adlens-cleanup` jobs and then the `adlens-api` service to its digest, checks the
API's health, and ends with the `adlens-db` job, because a migration ships with code that reads both the old and the
new shape.

[`infra/setup.sh`](infra/setup.sh) creates everything the workflow relies on (the APIs, the bucket with its
[CORS](infra/cors.json) and [lifecycle](infra/lifecycle.json) rules, the service accounts, the Workload Identity
provider, the `API_SECRETS` bundle, the image repository, the `adlens-db` job and the daily Scheduler job) and owns the
runtime config, which CI leaves untouched. The API is served at `https://api.useadlens.com` through a Cloud Run domain
mapping.

Secrets are set from a git-ignored `.env.production`, never `.env.local`, whose test keys must not reach production: the
script shows each key's source (never its value), asks before writing, merges the file into the `API_SECRETS` bundle and
redeploys. Once a deploy succeeds it destroys every other bundle version, so keep your own copy of a rotated value.

## Design decisions

Why the system is built this way, and what was rejected. Decisions that span the three repos are recorded here.

**Architecture**

- **Analysis runs as an on-demand Cloud Run Job**, not an always-on worker: at a few analyses a week a BullMQ worker on
  Redis sat idle over 99% of the time, while a job costs nothing idle and gives per-run isolation, retries and a hard
  timeout. Cloud Tasks pushing to a scale-to-zero service was the alternative.
- **An upload job's worker is dispatched at creation**, so Cloud Run's 24 s of provisioning overlaps the upload. The
  deadline is written before the dispatch, and the write that queues the job decides once whether it is left to that
  worker, so two executions never run one job. The cost is a billed execution for every upload never started.
- **The API pays its first analysis's one-time costs at start**: `warmUpFirstAnalysis` runs the first ffprobe, the Cloud
  Run client's setup and the first signBlob before the server listens (at most 3 s, with startup CPU boost), saving a
  fresh instance's first start 1 to 2 s.
- **One image, four entry points**: the API, the worker, the cleanup and the database job share code and an image but
  have separate composition roots, so the jobs have no HTTP layer and can't start a worker.
- **The cleanup is a scheduled Cloud Run Job, not a cron in the API**, which scales to zero and may run several
  instances, so an in-process timer would miss days or run twice. Cloud Scheduler starts it once a day for free.
- **MongoDB (Atlas) over Postgres**: a job is one nested document (settings, media facts, analysis), and Atlas provides
  the replica set Better Auth needs for transactions.
- **Live updates through Ably, published by the writer.** Socket.IO fed by a Change Stream kept a Cloud Run instance
  billed for every open socket. A hosted pub/sub holds the connections, every writer is AdLens code that publishes
  right after its write, and the message is only a signal: the API still decides what a user may read.
- **Gemini on Vertex AI with Application Default Credentials**, so no API key exists. Gemini 3 models are served from
  the `global` location.

**Correctness**

- **One owner for job status.** `JobLifecycle` performs every transition as a conditional update on the expected
  status; status written from several places allowed double charges and dispatches, regressions and jobs stuck after a
  crashed worker.
- **Charge when queued, refund at most once, never lose a refund.** The atomic charge is the gate, since a check before
  success would let concurrent requests through. Jobs keep their run ids until both refunds succeed and every refund is
  idempotent per run id, so a crash leaves ids for a later sweep, never a lost or double refund.
- **The rolling quota lives on the user document**, not in a `quotas` collection: single-document atomicity, runs pruned
  to the window, and they go away with the account.
- **Network limits are keyed by a derived HMAC, soft before hard.** The key comes from `BETTER_AUTH_SECRET`, so there is
  no extra secret to rotate; shared networks (offices, mobile carriers) get a Turnstile check before a block; jobs store
  only the network run's random id.
- **`X-Forwarded-For` is read from the right, not through `trust proxy`**: one unit-tested function picks the entry our
  own front end appended, and nothing else needs `req.ip`.
- **Retries know their attempt.** Transient failures exit 1 while attempts remain, and a retry calls Gemini again only if
  no earlier call may have been billed, so an unusable answer fails the job at once. `maxOutputTokens` caps what the one
  call can cost.
- **A run that ends without a result is never counted**: every failure is refunded in full, so nobody pays for a run
  that gave them nothing. Gemini is still called at most once per job, and the Vertex spend cap bounds what repeated
  failures cost.
- **Gemini 3 runs at its default temperature**, as Google advises; 0.2 made it loop into an 18k-token malformed reply in
  testing.
- **Verification trusts the stored object, not the client**: size and type come from object metadata and ffprobe. ffprobe
  reads only the accepted containers over HTTPS, runs with `PATH` as its only environment, and its errors are logged
  without the signed URL's query, which is a working read credential.
- **A failed start ends the job; it never goes back to `pending`**, since the web creates a new job for every run, and a
  job put back would stay `pending` for good.
- **Lazy expiry, backed by the daily cleanup**: abandoned jobs expire when their owner reads their jobs, so what they see
  is never stale, and the cleanup expires everyone's, so no job holds its charges for the whole window.
- **Tests run against a real MongoDB** (`mongodb-memory-server`), because the guarantees above live in query semantics
  that mocks can't prove. Auth flows run against the real Better Auth under Node's test runner, since Jest can't load
  it (ESM).

**Rules**

- **Rulesets are immutable, versioned data in MongoDB**, validated with the worker's own schema when published, so a
  rules change needs no deploy and every analysis records its version. The ruleset is content kept outside this repo;
  tests use a small fixture copied from real rules (`src/testing/test-ruleset.ts`).
- **Rules target placements and markets, not just platforms**: format caps such as the 6-second bumper apply only to
  their placement and UK/EU/US rules only in their market, and the schema refuses a rule whose placements don't belong
  to its platforms.
- **Nothing chosen means nothing ruled out**: an empty setting resolves to every value before rules are selected and the
  prompt is written, so leaving a setting empty and choosing all of it give the same analysis.

**Auth and hosting**

- **Anonymous users are real Better Auth users**, created only when a visitor starts an analysis or saves a preset, so
  every path works unchanged and crawlers create none; the cleanup deletes one a week after it was last seen.
- **One analysis without an account, then sign up; one without a confirmed email, then confirm.** The one analysis is
  shared by the anonymous user and the account and kept for good (`freeRunId`), and any analysis marks the browser.
  Clearing cookies gets a new anonymous user, so the per-network allowance (`IP_ANON_LIMIT`) stays the real bound.
- **Demo and sample videos live in a public bucket**, served at their plain address: no `signBlob` per video per request,
  no URL expiring on an open page, and a URL browsers can cache. It's a separate bucket because GCS refuses a public
  grant limited to a prefix; objects can be read, but the bucket can't be listed.
- **Linking moves ownership, not objects**: `jobs.userId` is rewritten, but videos stay where they were uploaded, since
  copying them inside the sign-in request would be slow and could half-fail. Deletions use `file.path`, and the purge
  runs in `deleteUser.beforeDelete`.
- **Indexes and migrations run in a job after the deploy, not on start**: building on start loads production on every
  cold start, lets whichever process starts first build a new index, and never removes one. An index that can't be
  built fails the deploy's last step, never an API start.
- **Admin routes look like routes that don't exist**: anyone but an admin gets the unknown-route 404, byte for byte (an
  e2e test compares the two), and admin status is read on every request. Answers are `Cache-Control: no-store`.
- **Same-site session cookies instead of bearer tokens**: the web app and the API share `useadlens.com`, so the httpOnly
  cookie is first-party for both. `*.vercel.app` and `*.run.app` are public suffixes, so this needs an own domain.
- **Keyless deploys, one image per commit**: Workload Identity Federation, limited to this repository's `main` by numeric
  ids, and both jobs and the API rolled to one digest, the jobs first. CI only swaps the image.
- **Infrastructure as a gcloud script**: a handful of set-once resources need only an idempotent, committed script;
  Terraform or Pulumi is the step up if it grows.
- **One Secret Manager secret for all of the API's secrets**: the free tier caps active versions per account, and one JSON
  bundle uses one version and one access per instance start. The trade-off is no per-key IAM, fine while the API and
  the worker share a service account.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md): free to read, run and learn from, not for commercial use. The contract
package ([adlens-shared](https://github.com/haggifer/adlens-shared)) is MIT.
