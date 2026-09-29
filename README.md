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
      MongoDB Atlas ─────┘  (jobs, ip_quotas, Better Auth collections) ◄┘
```

- **API** (`src/main.ts` → `AppModule`): NestJS 11 on Cloud Run at `api.useadlens.com`. Better Auth, Mongoose on Atlas,
  GCS signed URLs, ffprobe verification, quota, Socket.IO.
- **Worker** (`src/worker.ts` → `WorkerModule`): the same image run as an **on-demand Cloud Run Job**. The API starts
  one execution per analysis; the worker analyzes that job once and exits. It has no HTTP layer and no dispatcher, so
  it can never start another worker.
- **Cleanup** (`src/cleanup.ts` → `CleanupModule`): the same image run daily as the `adlens-cleanup` Cloud Run Job,
  started by Cloud Scheduler at 03:00 UTC. It deletes anonymous users unused for a week (see Authentication), and the
  videos of uploads left `pending` for a week ([`AbandonedUploadCleanupService`](src/cleanup/abandoned-upload-cleanup.service.ts)):
  every object's path is made from its user and job ids, so the jobs find them all. The job document stays, and
  analyzing it later answers `UPLOAD_INCOMPLETE`. A sample's shared video is never deleted.
- **Logs**: on Cloud Run (`LOG_FORMAT=json`) every process writes one JSON object per line through
  [`CloudLogger`](src/common/cloud-logger.ts): `severity` (so Logs Explorer can filter and alert on errors), `message`,
  `context` (the Nest class that logged it) and `stack_trace` (which Error Reporting groups). Better Auth's own messages
  go through the same logger. Locally the default is Nest's readable text.
- **Realtime**: a MongoDB Change Stream on `jobs` pushes every update to the owner's Socket.IO room. The stream is
  reopened from its last resume token after errors. Cloud Run bills an instance for as long as a socket to it is open,
  so [`JobsGateway`](src/realtime/jobs.gateway.ts) accepts a socket (WebSocket only, at most 3 per user per instance)
  only while its user has a job verifying, queued or analyzing, and closes the user's sockets right after the update
  that ends their last one.
- **Contract**: every request body, response and error has a Zod schema in `adlens-shared`. The API returns the
  public job shape only; owner, storage paths, execution names and accounting stay server-side.

## Job lifecycle

`pending → verifying → queued → analyzing → analyzed | error`

[`JobLifecycle`](src/jobs/job-lifecycle.service.ts) is the single owner of a job's status. Every transition is one
conditional update on the expected current status, so two racing callers can never both win (a double-clicked
"analyze" can't verify, charge or dispatch twice).

1. **Create** `POST /v1/jobs`: a `pending` job and a V4 signed PUT URL that binds the declared content type **and exact
   size** (`x-goog-content-length-range`), so the stored object must match the declaration. The
   [admission check](#abuse-limits) runs first, read-only, so nobody uploads a video only to be refused at analyze.
2. **Start** `POST /v1/jobs/:id/analyze` ([`JobAnalysisService`](src/jobs/job-analysis.service.ts)):
   - **claim** `pending → verifying` (409 `JOB_NOT_PENDING` for a second caller);
   - **verify** ([`VideoVerifier`](src/jobs/verification/video-verifier.service.ts)) from the stored object's own
     metadata plus ffprobe over a signed read URL (range reads, no download). A bad file (unreadable, too long, too
     large, unsupported type) is rejected with 422 and deleted. A missing upload (409 `UPLOAD_INCOMPLETE`) or a storage
     or network problem (503) puts the job back to `pending` and never deletes the user's file. A job on a
     [sample ad](#sample-ads) skips this step: its video was measured when the sample was published;
   - **charge** one run on the user's network, then one on the user, and move to `queued` (429 `QUOTA_EXCEEDED` when
     the user's window is spent; the [network rules](#abuse-limits) answer with their own codes). If the user charge
     fails, the network run is given back;
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

**Quota** ([`QuotaService`](src/quota/quota.service.ts)): N analyses (`QUOTA_LIMIT`) per rolling 7-day window. Each
charged run is stored on the user's Better Auth document (`runs: { id, startedAt, jobId }[]`) and stops counting 7
days after it started; `GET /v1/me/quota` reports `nextFreeAt`, when the oldest counted run does. A charge is one
conditional pipeline update on that document: it counts the runs still in the window, drops older ones and appends
the new run, so concurrent requests can't overdraw and the list stays a few entries long. The limit is read from
config on every charge. The job records its run (`chargedRunId`); ending a run clears that field in the same write
that sets the final status, and the pre-image decides who refunds (`$pull` of that run), so a refund happens at most
once. Deleting a job keeps its run counted.

**Admins have no limit**: set `isAdmin: true` on the user's document in Better Auth's `user` collection. Their runs
are still counted but never capped, and `GET /v1/me/quota` reports `limit: null`. The field is declared to Better Auth
with `input: false`, so sign-up and profile updates can't set it.

## Abuse limits

Anyone can analyze without signing up, so free runs are bounded per network as well as per user:

| Rule | Limit per rolling 7 days | When hit |
| --- | --- | --- |
| Per user (anonymous or not) | `QUOTA_LIMIT` (3) | 429 `QUOTA_EXCEEDED` |
| Anonymous users per network | `IP_ANON_LIMIT` (3) in total | 429 `SIGN_UP_REQUIRED` |
| Everyone per network, soft | `IP_SOFT_LIMIT` (10) | a Turnstile check for each further analysis: 403 `CHALLENGE_REQUIRED` / `CHALLENGE_FAILED` |
| Everyone per network, hard | `IP_HARD_LIMIT` (30) | 429 `NETWORK_QUOTA_EXCEEDED` |
| Refunded failures after Gemini answered, per network | `IP_FAILURE_REFUND_LIMIT` (3) | the failed run stays counted, for the user and the network |

- **The network** is the IPv4 address or the IPv6 /64 prefix (an IPv4-mapped address counts as IPv4). The address is
  the `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS` from the right (1 on Cloud Run: the one Google's front end appends),
  or the socket address when the header is absent; never the leftmost entry, which the client controls
  ([`ClientNetworkResolver`](src/ip-quota/client-network.resolver.ts)). Each lookup logs only the header's entry count.
- **Storage** ([`IpQuotaService`](src/ip-quota/ip-quota.service.ts)): one `ip_quotas` document per network, keyed by
  `HMAC-SHA256(key, network)`, the key derived from `BETTER_AUTH_SECRET` with HKDF. It holds
  `runs: { id, startedAt, jobId, anonymous }[]` and a TTL `expiresAt` 7 days after the last charge. The address itself
  is never stored or logged. A charge is one conditional pipeline update, as for the user quota; a refund is `$pull`
  by run id, found through an index on `runs.id`, so the worker needs no key.
- **Order** ([`AnalysisAdmission`](src/jobs/analysis-admission.service.ts)): `POST /v1/jobs` and `/from-sample` check
  the user cap and the network rules read-only; analyze charges the network, then the user. The job records both runs
  (`chargedRunId`, `chargedIpRunId`); the write that ends a run clears both, so each is refunded at most once.
- **Failed analyses**: a failure before Gemini answers (provider errors, timeouts, a stuck worker) is always
  refunded. Once Gemini has answered, the call is billed even when the answer can't be used (cut off, blocked or
  malformed), so such a failure is refunded only while the network has refunds of those left
  (`IpQuotaService.refundFailure`, one conditional update that records the refund's time in `refundedFailures`);
  otherwise both runs stay counted. Without the cap, a video that always fails could be re-run for free until the
  Vertex spend cap stopped every analysis. A cut-off or blocked answer isn't retried, a malformed one once
  (`ModelAnswerError`), and every attempt's tokens are added to the job's `usage`.
- **Turnstile** ([`ChallengeVerifier`](src/challenge/challenge-verifier.ts)): the web shows the check to everyone and
  sends its token with a job creation when it has one. A visitor without an account can't start before the check
  passes; a member who starts before it's solved sends none. The API calls Cloudflare's `siteverify` only when a rule
  asks for it (always for anonymous users), ignores a token no rule needs, and records `hasPassedChallenge` on the job
  for analyze. Without `TURNSTILE_SECRET_KEY` a required check never passes.
  A network that crosses the soft limit between creating and analyzing a job made without the check gets
  `CHALLENGE_REQUIRED` at analyze, and the user starts again.
- **Admins** (`isAdmin: true`) skip every network rule.

## Authentication

[Better Auth](src/auth/auth.instance.ts) on the app's own Mongo connection: email and password, plus Google and GitHub:

- **Sessions are httpOnly, `SameSite=Lax` cookies.** The web app (`www.useadlens.com`) and the API (`api.useadlens.com`)
  share the parent domain (`COOKIE_DOMAIN`), so the cookie is first-party for both and no token ever sits in
  JavaScript-readable storage. Socket.IO authenticates its handshake with the same cookie.
- **Anonymous sessions** (Better Auth's `anonymous` plugin): the web signs a visitor in anonymously right before their
  first analysis, never on page load. An anonymous user is a real `user` document (`isAnonymous: true`, email
  `<id>@anonymous.placeholder.invalid`, which is never sent mail), so jobs, the quota, history, replay and Socket.IO
  work unchanged. When they sign up or in, `onLinkAccount` moves their jobs (`userId`) and quota runs to the account
  ([`AccountDataService.adopt`](src/account/account-data.service.ts)), then the plugin deletes the anonymous user.
  `/verify-email` links only when the anonymous session confirming it is the one that started that sign-up: the
  address is recorded as `pendingLinkEmail` on the anonymous user document (written straight to the collection, never
  through a Better Auth field), and a mismatch answers 403 `ACCOUNT_LINK_FAILED` and leaves the history with the
  anonymous user — otherwise a confirmation link mailed to someone else could hijack a visitor's analyses.
  `/link-social` is refused for an anonymous session (it could attach a provider and stay anonymous forever), and so
  is `/delete-anonymous-user` (it deletes through Better Auth's internal adapter and would skip the purge).
- **Abandoned anonymous users are deleted after a week.** Every time an anonymous session is created or refreshed
  (Better Auth refreshes a session at most once a day), a session hook stamps `lastSeenAt` on the user. The daily
  cleanup job ([`AnonymousCleanupService`](src/cleanup/anonymous-cleanup.service.ts)) deletes each anonymous user whose
  `lastSeenAt` (or, without one, `createdAt`) is more than 7 days old and who has no unexpired session: first its jobs
  and uploads (`AccountDataService.purge`), then its sessions, accounts and the user document. A user whose purge fails
  stays and is tried again the next day. The stamp must live on the user because signing out ("Forget this browser")
  deletes the session.
- **Disposable email domains are refused at sign-up** (`DISPOSABLE_EMAIL`), from the maintained
  `disposable-email-domains-js` list. Google and GitHub sign-in are unaffected.
- **Email verification is required** before the first sign-in; signing in unverified resends the link.
- **Google and GitHub sign-in** (OAuth, callbacks on this API: `/api/auth/callback/{google,github}`). A provider is
  on when both its client id and secret are set; half a pair stops the API at startup. A social sign-in links to an
  existing user with the same email only when the provider reports that email as verified **and** the user's own
  email is verified, so an unconfirmed sign-up can't be taken over. Google always shows its account picker.
  The providers' access, refresh and ID tokens are never stored: AdLens only needs to know who signed in.
- **Password reset** by emailed link (1-hour token); a reset revokes every existing session.
- **Emailed links open the web app** (`/confirm-email`, `/reset-password`), never the API: users only see the site's
  domain, and the confirmation page calls `verify-email` from the browser once it loads, so mail scanners that fetch
  links without running JavaScript can't use the token up. Confirming signs the user in (Better Auth sets the session
  cookie on that response).
- **Account deletion** (password-confirmed, or within a day of signing in for users without a password) purges the
  user's jobs and every uploaded object (including videos of jobs adopted from an anonymous session, which stay under
  that session's prefix) before Better Auth removes the account; the quota runs live on the user document, so Better
  Auth's own delete clears them.
- **An email that can't be sent fails the request.** Emails go through Resend from `mail.useadlens.com`. Better Auth
  runs its email callbacks in a way that only logs their errors, so the callbacks queue each message for the request
  and an `after` hook sends it: a failed send answers 503 `EMAIL_NOT_SENT` instead of a success the user would wait on
  forever. The cost is that a password-reset request for an existing address takes a Resend round trip longer than one
  for an unknown address.
- **Better Auth's rate limits** (its defaults, plus 10 anonymous sign-ins an hour per client) are counted in MongoDB,
  so they hold across instances, by [`createRateLimitStorage`](src/auth/rate-limit-storage.ts): one `rate_limits`
  document per client and path, keyed by `HMAC-SHA256(key, "<ip>|<path>")` with its own HKDF key from
  `BETTER_AUTH_SECRET`, and deleted by a TTL index when its window ends. Better Auth resolves that address itself
  (only from a single-entry `X-Forwarded-For`; requests it can't read share one bucket), not through
  `ClientNetworkResolver`. It only rate-limits when `NODE_ENV` is `production`.
- **Sessions don't store the address.** Better Auth records it on every session; a
  `databaseHooks.session.create.before` hook sets `ipAddress` to null and keeps the user agent.
- **Better Auth's collections are indexed at startup.** Its Mongo adapter only creates indexes a plugin schema
  declares, and none does, so `user`, `session`, `account` and `verification` would have only `_id` and every session
  check would scan `session`. [`AuthIndexes`](src/auth/auth-indexes.ts) creates, on every API start, the indexes
  behind the adapter's lookups: `session.token` (unique), `session.userId`, `user.email` (unique), `account.userId`,
  `account.{providerId, accountId}` (social sign-in) and `verification.identifier`, plus TTL indexes on
  `session.expiresAt` and `verification.expiresAt`, because Better Auth deletes an expired session only when its
  cookie comes back. They use Better Auth's own index names (`<table>_<fields>_<idx|uidx>`, `_ttl` for the TTLs). The
  worker doesn't create them: it never reads these collections through Better Auth.

## API

Every `/v1/*` route except `GET /v1/samples` and `POST /v1/contact` requires a session; [`SessionGuard`](src/auth/session.guard.ts) resolves the user from the Better Auth
session cookie (never from the body) and every query is scoped by it. Errors share one shape,
`{ statusCode, errorCode, message, issues? }`, with `errorCode` from `adlens-shared`.

| Method & path               | Purpose                                                         | Returns                        |
| --------------------------- | --------------------------------------------------------------- | ------------------------------ |
| `ALL /api/auth/*`           | Better Auth (public)                                            | Better Auth                    |
| `GET /health`               | Liveness (public)                                               | `{ status, service, time }`    |
| `POST /v1/jobs`             | Admission check (optional challengeToken), then a pending job and its signed upload target | `{ job, upload }`              |
| `POST /v1/jobs/from-sample` | Admission check, then a pending job on a published sample ad (no upload) | `{ job }`                      |
| `POST /v1/jobs/:id/analyze` | Verify → charge network and user → dispatch                     | **202** `{ job }`              |
| `GET /v1/jobs`              | The caller's jobs, newest first (`?limit=` ≤ 50, `?cursor=`)    | `{ jobs, nextCursor }`         |
| `GET /v1/jobs/:id`          | One owned job                                                   | `{ job }`                      |
| `GET /v1/jobs/:id/video`    | A 15-minute signed URL for replaying the verified upload        | `{ url, expiresAt }`           |
| `DELETE /v1/jobs/:id`      | Delete a finished or unstarted job and its uploaded video (409 `JOB_IN_PROGRESS` while it runs) | **204**                        |
| `GET /v1/me/quota`          | The caller's quota window                                       | `{ quota }`                    |
| `POST /v1/contact`          | Email a Contact form message to the team (public, rate-limited) | **204**                        |
| `GET /v1/samples`           | Published sample ads with preview URLs (public)                 | `{ samples }`                  |

## Ad-policy rules

Rules are data. The ruleset is authored **outside this repo**, as a JSON file in the shape of
[`ruleSetSchema`](src/rules/schema.ts), and published to MongoDB as an **immutable version** with
`npm run rules:publish -- <path/to/rules.json>` (validated by the same Zod schema the worker parses it with; a
version that already exists is refused). The worker serves the newest published version via
[`RulesetService`](src/rules/ruleset.service.ts), so a rules update needs no redeploy, and every analysis records the
`rulesetVersion` it ran with.

Selection ([`src/rules/index.ts`](src/rules/index.ts)) targets the job's settings: its **platforms** (YouTube also pulls
in Google Ads policy), its **markets** (global rules always apply; UK/EU/US rules only in their market) and, for
format-specific rules such as the 6-second bumper cap, its **placements**. No platform chosen means every platform, and
no market chosen means every market, so an ad is never checked against nothing; placement specs still apply only to
their chosen placement, and the schema requires a rule's placements to belong to its platforms, so every video rule is
selected by some settings. Selected rules are then routed by `modality`:

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
src/        main.ts (API), worker.ts (analysis worker) and cleanup.ts (daily cleanup), one Nest module per feature: jobs, analysis, rules, quota,
            ip-quota, challenge, auth, account, mail, storage, realtime, database, config
test/       e2e (Supertest) and auth-flow tests
scripts/    ruleset publishing, dependency guard
infra/      gcloud setup script and bucket CORS policy
```

## Environment

All variables are validated at startup by [`src/config/env.ts`](src/config/env.ts); a missing or malformed value stops
the process with a readable error. Locally they come from `.env` (non-secret, committed) and `.env.local` (secrets).
In production, secrets come from one Secret Manager secret, `API_SECRETS`, mounted as a JSON file and merged into the
config before validation — see `SECRETS_FILE` below and [`infra/setup.sh`](infra/setup.sh).

| Variable                 | Default                 | Purpose                                                                     |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------- |
| `SECRETS_FILE`           | —                       | Path to a mounted JSON file of secrets; unset locally. Its keys fill gaps in the environment, never override it |
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
| `LOG_FORMAT`             | `text`                  | `json` on Cloud Run: one Cloud Logging entry per line, with `severity`      |
| `STORAGE_KEY_FILE`       | —                       | Local only: SA key used to sign V4 URLs (user ADC can't sign)               |
| `GCP_REGION`             | `europe-west1`          | Region of the analysis Cloud Run Job                                        |
| `ANALYZE_JOB_NAME`       | `adlens-analyze`        | The Cloud Run Job the API executes                                          |
| `ANALYZE_LOCAL`          | `0`                     | `1`: run each analysis as a local `node dist/worker` child process          |
| `ANALYZE_MAX_RETRIES`    | `2`                     | Must equal the job's `--max-retries`, so the worker knows its last attempt  |
| `QUOTA_LIMIT`            | `3`                     | Analyses per rolling 7-day window                                           |
| `IP_ANON_LIMIT`          | `3`                     | Analyses by anonymous users per network in a rolling 7-day window           |
| `IP_SOFT_LIMIT`          | `10`                    | Analyses per network before everyone needs a Turnstile check                |
| `IP_HARD_LIMIT`          | `30`                    | Analyses per network, for everyone                                          |
| `IP_FAILURE_REFUND_LIMIT`| `3`                     | Refunds per network of analyses that failed after Gemini answered           |
| `TRUSTED_PROXY_HOPS`     | `1`                     | Proxies that append to `X-Forwarded-For` (1 on Cloud Run)                   |
| `TURNSTILE_SECRET_KEY`   | —                       | Cloudflare Turnstile secret; unset, a required check never passes           |
| `GEMINI_MODEL`           | `gemini-3.8-flash`      | Model id                                                                    |
| `GEMINI_LOCATION`        | `global`                | Vertex serving location                                                     |
| `WORKER_JOB_ID`          | —                       | Worker only: set per execution by the dispatcher                            |
| `CLOUD_RUN_TASK_ATTEMPT` | `0`                     | Worker only: set by Cloud Run on each attempt                               |

## Local development

```bash
gcloud auth application-default login   # once; the account needs Vertex AI User
npm install
# .env.local: MONGODB_URI, BETTER_AUTH_SECRET, RESEND_API_KEY, ANALYZE_LOCAL=1, STORAGE_KEY_FILE, TURNSTILE_SECRET_KEY
npm run start:dev                        # keeps dist/ built, which the local worker process runs
```

With `ANALYZE_LOCAL=1` each analysis runs `node dist/worker` as a child process, the same entry point Cloud Run runs.
Vertex reads the real `gs://` object, so a real bucket and ADC are needed for the analysis step.

Locally, use Cloudflare's test secret 1x0000000000000000000000000000000AA (always passes) with the web's test site
key; 2x0000000000000000000000000000000AA always fails.

## Tests

```bash
npm test          # unit: quota, network quota, job lifecycle, pipeline, verification, client IP, Better Auth indexes (real MongoDB via mongodb-memory-server)
npm run test:e2e  # Supertest against the Nest app with fake storage, prober, dispatcher and auth
npm run test:auth # after a build: sign-up, verification, reset, deletion, anonymous linking and rate limits against the real Better Auth
```

The unit tests run the Mongo-dependent logic against a real in-memory MongoDB, because the guarantees that matter
(conditional transitions, concurrent charges, at-most-once refunds) live in query semantics that mocks can't prove.

## Deployment

Every push to `init-setup` that passes CI deploys to production
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The `deploy` job signs in to Google Cloud with Workload
Identity Federation: GitHub's OIDC token is exchanged for a short-lived credential, no service account key exists, and
only this repository's pushes to `init-setup` are accepted. It builds one image, pushes it to Artifact Registry, rolls
the `adlens-analyze` and `adlens-cleanup` jobs and then the `adlens-api` service to that digest, and ends with a health check.

[`infra/setup.sh`](infra/setup.sh) (plain gcloud, see [Design decisions](#design-decisions)) creates
everything the workflow relies on: the APIs, the bucket and its CORS policy from [`infra/cors.json`](infra/cors.json),
the runtime and deploy service accounts, the Workload Identity provider, the `API_SECRETS` bundle, the image
repository and the Cloud Scheduler job that starts `adlens-cleanup` daily. It also owns the runtime config (env vars,
secrets, the analysis job's 2 retries and 15-minute timeout, the cleanup job's schedule), which CI
leaves untouched, and can deploy the current checkout by hand. The API is served at `https://api.useadlens.com`
through a Cloud Run domain mapping.

To create or rotate a secret, export any subset of `MONGODB_URI`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`,
`CONTACT_EMAIL`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` and `TURNSTILE_SECRET_KEY`, then run the script: it
prints the source of every key (exported, the bundle, a legacy secret, or absent — never a value) and asks for
confirmation before writing, merges the exported values into the `API_SECRETS` bundle (a key you didn't export keeps
its current value), and deploys both the job and the API mounting `API_SECRETS` at `/secrets/api.json`
(`SECRETS_FILE`). Both processes run as the same runtime service account today, so both mount the whole bundle even
though the worker only reads `MONGODB_URI` from it. To remove a key from the bundle entirely, edit it by hand
(`gcloud secrets versions access latest --secret=API_SECRETS`, edit the JSON, then
`gcloud secrets versions add API_SECRETS --data-file=edited.json`) — the script only ever adds or overwrites keys,
it never drops one on its own. A key removed this way comes back on the next run of the script if its legacy
individual secret still exists: the script's source order is exported, then the bundle, then the legacy secret of
the same name, so a hand-removed key is still "absent" only until that legacy secret is deleted too (the
confirmation prompt shows `legacy` as its source when this happens).

**Once a deploy succeeds, the script destroys every other `API_SECRETS` version**, enabled or disabled (the free
tier counts disabled versions too), so a rotation can't be undone from Secret Manager afterwards — keep your own
copy of anything you rotate away from. The legacy individual secrets it can still migrate from
(`MONGODB_URI`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `CONTACT_EMAIL`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_SECRET`, `TURNSTILE_SECRET_KEY`) and the unused `GEMINI_API_KEY` are never deleted automatically; the
script prints a reminder, and deleting them (a one-time manual step, once the bundle is verified live) is on the
maintainer.

## Design decisions

Why the system is built this way, and what was rejected. Decisions that span the three repos are recorded here.

**Architecture**

- **Analysis runs as an on-demand Cloud Run Job.** It started as a BullMQ worker on Redis: an always-on service idle
  over 99% of the time at a few analyses a week. A job costs nothing when idle and gives per-run isolation, retries and
  a hard timeout. Cloud Tasks pushing to a scale-to-zero service would also work; worker pools with an external
  autoscaler were more moving parts for no gain at this load.
- **One image, three entry points.** The API (`dist/main`), the worker (`dist/worker`) and the cleanup (`dist/cleanup`)
  share code and an image but have separate composition roots, so the jobs have no HTTP layer and can't start a worker.
- **The cleanup is a scheduled Cloud Run Job, not a cron inside the API.** The API scales to zero and may run several
  instances, so an in-process timer would miss days or run twice; Cloud Scheduler starting a job runs it once a day for
  free (3 scheduler jobs per billing account are free) and shows each run's outcome in the console.
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
  concurrent requests pass a non-consuming check. The job stores the run it was charged for (`chargedRunId`); the
  write that ends the run clears that field, and the pre-image of that write decides who refunds, by `$pull` of that
  run, so exactly one caller refunds.
- **Rolling quota window on the user document instead of a `quotas` collection.** The limit follows config;
  single-document atomicity; runs pruned to the window, so the document stays small; the runs go away with the
  account.
- **Network limits keyed by a derived HMAC, soft before hard.** The key is derived from `BETTER_AUTH_SECRET`, so no
  extra secret needs managing or rotating on its own; rotating that secret resets every network's count. Shared
  networks (offices, mobile carriers) get a Turnstile check at the soft limit instead of a block. Jobs store only the
  network run's random id, never the hash, so nothing network-derived outlives the 7-day document.
- **`X-Forwarded-For` read from the right, not `trust proxy`.** One function with a configured hop count, unit-tested,
  picks the entry our own front end appended; Express's `trust proxy` isn't set, because nothing else needs `req.ip`.
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
- **Rulesets are immutable, versioned data in MongoDB.** `npm run rules:publish -- <file>` validates with the worker's
  own schema and refuses an existing version, so a rules change needs no deploy and every analysis records its
  `rulesetVersion`. A script was chosen over an admin endpoint, which would need an admin identity model. The ruleset
  file isn't kept in this repo: rules are content, maintained outside it, and tests use a small fixture
  (`src/testing/test-ruleset.ts`) copied from real rules.
- **Rules target placements and markets, not just platforms.** Format caps such as the 6-second bumper apply only to
  their placement, and UK/EU/US rules only in their market; a test proves every rule is reachable.

**Auth and hosting**

- **Anonymous users are real Better Auth users**, created only when a visitor starts an analysis, so every existing
  path (jobs, quota, history, Socket.IO) works unchanged and crawlers create none. Once nobody can reach one (its
  session expired or was signed out), the daily cleanup deletes it a week after it was last seen.
- **Linking moves ownership, not objects.** `jobs.userId` is rewritten and the runs are merged, but the GCS objects stay
  where they were uploaded: copying each video inside the sign-in request would be slow and could half-fail, and the
  verifier, replay URLs and worker already read `file.path`. So deleting a job deletes its `file.path`, and the purge
  deletes adopted uploads before the account's own prefix. The purge must stay in `deleteUser.beforeDelete`: the
  anonymous plugin deletes a linked anonymous user through the internal adapter, which skips it.
- **A Better Auth index that can't be built is logged, not fatal.** Without it the API works as it did before, only
  slower and keeping expired rows; failing the start would stop every new instance, and Cloud Run starts one on every
  cold start, so one bad row (a duplicate email) would take the API down until the data was fixed. Each index is
  created on its own, and the log names the index and MongoDB's error code, never the message, which quotes the
  duplicate value. Declaring the indexes through a Better Auth plugin schema was rejected: its adapter can't create
  a TTL, and it creates indexes before each write, so a failed unique index would fail every sign-up and sign-in.
- **Same-site session cookies instead of bearer tokens.** The web app and the API share `useadlens.com`, so Better
  Auth's httpOnly cookie is first-party for both and no token sits in JavaScript-readable storage. `*.vercel.app` and
  `*.run.app` are on the Public Suffix List, so this needs an own domain. Emails are sent from the `mail.` subdomain to
  keep its sending reputation separate.
- **Keyless deploys, one image per commit.** GitHub Actions authenticates through Workload Identity Federation, limited
  to this repository's `init-setup` branch by numeric ids, so no long-lived key exists. The worker job and the API are
  rolled to the same digest, the job first. CI only swaps the image; runtime config stays in `infra/setup.sh`.
- **Infrastructure as a gcloud script.** The infrastructure is a handful of set-once resources, so an idempotent,
  committed script is enough; Terraform or Pulumi would be the step up if it grows.
- **One Secret Manager secret for all of the API's secrets.** The free tier caps active secret *versions* per billing
  account, and every secret is at least one version; one JSON bundle (`API_SECRETS`) uses a single version however
  many keys it holds, and costs one access per instance start instead of one per secret. The trade-off is no per-key
  IAM binding — anything that can read the bundle can read every key in it — which is fine while the API and the
  worker share one runtime service account; split into per-identity secrets when the worker gets its own.
