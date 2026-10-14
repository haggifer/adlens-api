# adlens-api

Backend for **AdLens**, AI video-ad diagnostics. You upload a short video ad; it is verified, analyzed against an
ad-policy ruleset of several hundred rules with one Gemini pass, and you get cited, timestamped findings pushed to the
browser in realtime. This repo holds the HTTP API and the analysis worker; the web client and the API contract live in
their own repos.

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
  started by Cloud Scheduler at 03:00 UTC. It first expires every user's abandoned jobs, as a read of one's own jobs
  does (see the job lifecycle), so a job whose owner never comes back doesn't stay in flight holding its charges, and
  ends every job still `pending` 6 hours after its creation as `UPLOAD_FAILED`. Then it deletes anonymous users unused
  for a week (see Authentication), and the video of every job that backs no results: created over 6 hours ago and
  `error` (failed, rejected, expired or never started) or still `pending`
  ([`AbandonedUploadCleanupService`](src/cleanup/abandoned-upload-cleanup.service.ts)). Jobs are aged from their
  creation, not their last update, so a job expired earlier in the same run loses its video in that run; a job still
  in progress after the expiry is running, and keeps its video. Every object's path is made from its user and job ids,
  so the jobs find them all. The job document stays, marked `videoDeletedAt` so it is handled once (with no upper age
  bound, a missed or failed day is caught up the next). An analyzed job keeps its video, which its findings'
  timestamps replay, and a sample's shared video is never deleted. Deleting a job removes its document, so a job
  deleted while the create-only upload URL signed at its creation still worked (15 minutes, plus an hour's margin for
  an upload still arriving) leaves a tombstone (`upload_tombstones`: path, `deleteAfter`), and the cleanup then
  deletes that path, which a late PUT could have filled, unless a job still references it
  ([`UploadTombstoneCleanupService`](src/cleanup/upload-tombstone-cleanup.service.ts)).
  Last, it retries the refunds that ended jobs still owe (see Quota), including any the expiry couldn't make. A step
  that fails for one job or user logs it and goes on; any failure makes the execution exit 1.
- **Logs**: on Cloud Run (`LOG_FORMAT=json`) every process writes one JSON object per line through
  [`CloudLogger`](src/common/cloud-logger.ts): `severity` (so Logs Explorer can filter and alert on errors), `message`,
  `context` (the Nest class that logged it) and `stack_trace` (which Error Reporting groups). Better Auth's own messages
  go through the same logger. Locally the default is Nest's readable text.
- **Realtime**: a MongoDB Change Stream on `jobs` pushes every update to the owner's Socket.IO room. The stream is
  reopened from its last resume token after errors, or from now when MongoDB can never resume from that token (its
  history rolled out of the oplog); a socket that missed an update refetches the job when it reconnects. Cloud Run bills an instance for as long as a socket to it is open,
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
   size** (`x-goog-content-length-range`), so the stored object must match the declaration, and only creates the object
   (`x-goog-if-generation-match: 0`), so a verified video can't be replaced by a second PUT. The
   [admission check](#abuse-limits) runs first, read-only, so nobody uploads a video only to be refused at analyze.
2. **Start** `POST /v1/jobs/:id/analyze` ([`JobAnalysisService`](src/jobs/job-analysis.service.ts)). A step that
   fails ends the job in `error`, with any charge refunded, and never puts it back to `pending`: the web never starts a
   job twice, it creates a new one. The HTTP answer still says what went wrong.
    - **claim** `pending → verifying` (409 `JOB_NOT_PENDING` for a second caller);
    - **verify** ([`VideoVerifier`](src/jobs/verification/video-verifier.service.ts)) from the stored object's own
      metadata plus ffprobe over a signed read URL (range reads, no download; the image runs Debian's ffprobe, because
      `ffprobe-static`'s Linux build segfaults on any hostname lookup, see the Dockerfile). A bad file (unreadable, too long, too
      large, unsupported type) is rejected with 422 and deleted; a file ffprobe can't decode is probed a second time
      first, since a range read cut off by the network looks the same. A missing upload (409 `UPLOAD_INCOMPLETE`)
      ends the job as `UPLOAD_FAILED`, and a storage or network problem (503 `UNAVAILABLE`) as `VIDEO_CHECK_FAILED`;
      neither deletes the user's file, which the daily cleanup deletes with every error job's video. A job on a
      [sample ad](#sample-ads) skips this step: its video was measured when the sample was published, and a sample no
      longer published answers 404 and ends the job as `VIDEO_CHECK_FAILED`;
    - **charge** one run on the user's network, then one on the user, and move to `queued` (429 `QUOTA_EXCEEDED` when
      the user's window is spent, `SIGN_UP_REQUIRED` or `EMAIL_CONFIRMATION_REQUIRED` for an anonymous user or an
      unconfirmed account; the [network rules](#abuse-limits) answer with their own codes). If the user charge
      fails, the network run is given back. A refused or failed charge ends the job as `ANALYSIS_FAILED` (no job error
      code names a refusal; the answer's own code tells the user why, and the job's server-side `errorDetail` keeps it);
    - **dispatch** the worker. If that fails, the job ends as `ANALYSIS_FAILED` and the charge is refunded (503).
3. **Analyze** ([`AnalysisPipeline`](src/analysis/pipeline/analysis-pipeline.service.ts)): `queued → analyzing`,
   select the rules for the chosen platforms and markets, check the metadata rules in code, run one Gemini pass through
   the [`VideoReviewer`](src/analysis/review/video-reviewer.ts) port, then `analyzing → analyzed`. The Gemini request
   and how its answer is read ([`gemini-review.ts`](src/analysis/review/gemini-review.ts)) and the analysis assembly
   ([`analysis-assembly.ts`](src/analysis/pipeline/analysis-assembly.ts)) need neither Nest nor the database, so the
   [lab](https://github.com/haggifer/adlens-lab) runs the same code with its overrides on top.
4. **Fail well**: the worker knows its attempt (`CLOUD_RUN_TASK_ATTEMPT`). A transient failure (provider overload,
   network) exits 1 so Cloud Run retries it, unless the call may have been billed (below); a permanent failure, or any
   failure on the last attempt, ends the job in `error` with `ANALYSIS_FAILED`. The Gemini call has a 10-minute
   timeout, well inside the 15-minute task timeout. A job is never billed twice: the worker marks the job
   (`modelCallStartedAt`, a conditional write) before calling Gemini, and an attempt that finds the mark set doesn't
   call again but fails the job as if Gemini had answered. Only a call Vertex refused with an HTTP error status (a 4xx or 5xx response such as 429 or 503, which
   Gemini doesn't bill) clears the mark, so those stay retryable. After our own timeout, a dropped connection or any
   other failure Vertex may still have generated, and billed, an answer, so the mark stays, and the attempt fails the
   job at once rather than leave it to a retry that could only do the same.
5. **Nothing stays in flight forever**: when a user reads their jobs, and for every user in the daily cleanup, anything
   stuck (a worker that crashed or never started) is expired: `verifying` after 10 minutes ends as `VIDEO_CHECK_FAILED`,
   `queued`/`analyzing` ends as `ANALYSIS_TIMED_OUT`, refunded, in two phases: 5 minutes after it was queued
   (`queuedAt`, so the worker's own writes don't extend it) while its Gemini call hasn't started, and 12 minutes after
   the call started (`modelCallStartedAt`) once it has. That outlasts the call's 10-minute timeout, so a live worker
   always settles the job first; a refused call clears the mark and puts the job back on the first clock. If the job
   ended anyway before the answer was stored, the answer is dropped but its call is still recorded in `usage.calls`. A job still `pending` 6 hours
   after its creation (its upload never came, or no run was started) ends as `UPLOAD_FAILED`; each of these is a
   conditional update on the status it was found in, so a job started meanwhile runs on.

**Quota** ([`QuotaService`](src/quota/quota.service.ts)): N analyses (`QUOTA_LIMIT`) per rolling 7-day window for a
confirmed account. Before an email is confirmed a user gets one analysis in total (`PROVISIONAL_QUOTA_LIMIT`), for
good: the charge records it as `freeRunId` on the user document, which never leaves with the window, moves with the
runs onto the account an anonymous user signs up or in with, and is cleared only when that run is refunded. So an
anonymous run and an unconfirmed run are one analysis between them. `GET /v1/me/quota` reports `QUOTA_LIMIT` to
everyone but an admin, so the web can show the account's weekly allowance from sign-up on (4 of 5 left after the one
analysis, while Run asks to confirm the email); the runs an anonymous user brings keep counting, so confirming opens
the rest of the week's allowance without resetting it.
The one analysis is also one per browser: signing in deletes the anonymous user, so after signing out a new one (or a
new unconfirmed account) would get another. Starting any analysis, whoever runs it, sets the API's own
`adlens_free_run` cookie (httpOnly, host-only, 400 days, the most browsers keep) to that user's id, and admission
(`GET /v1/admission`, job creation and the start of a run, before it is charged) then refuses a visitor, an anonymous user or an unconfirmed account in that
browser (`SIGN_UP_REQUIRED` / `EMAIL_CONFIRMATION_REQUIRED`), unless that run was refunded: a cookie naming an
anonymous user or unconfirmed account without a `freeRunId` holds nothing, while one naming a user that is gone or an
account that was confirmed (whose runs never record one) still counts. Linking moves the cookie to the account when it
named the anonymous user, as the run moves. The one named may still retry a refunded run. Clearing cookies gets around
it, which the network's anonymous allowance (`IP_ANON_LIMIT`) still bounds.
Each charged run is stored on the user's Better Auth document (`runs: { id, startedAt, jobId }[]`) and stops counting 7
days after it started; `GET /v1/me/quota` reports `nextFreeAt`, when the oldest counted run does. A charge is one
conditional pipeline update on that document: it counts the runs still in the window, drops older ones and appends
the new run, so concurrent requests can't overdraw and the list stays a few entries long. The limit is read from
config on every charge. The job records its run (`chargedRunId`) before the charge and keeps it until the refund
succeeds, so no charge exists that no job holds. A refund is `$pull` of that run, safe to repeat, so it happens at most
once however often it is tried; ending a run refunds right away, and a refund that fails or is cut short stays on the
ended job (`error`, or `pending` from before 2026-10-02, still holding a run id) until
`JobLifecycle.refundOwedCharges` retries it, on every read of the user's jobs and in the daily cleanup. Deleting a job
keeps its run counted.

**Admins have no limit**: set `isAdmin: true` on the user's document in Better Auth's `user` collection. Their runs
are still counted but never capped, and `GET /v1/me/quota` reports `limit: null`. The field is declared to Better Auth
with `input: false`, so sign-up and profile updates can't set it.

## Abuse limits

Anyone can analyze without signing up, so free runs are bounded per network as well as per user. An account that
hasn't confirmed its email (`emailVerified` false on its user document, read by
[`getUserAccess`](src/common/user-access.ts)) meets every rule of an anonymous user, and is asked to confirm its
email (`EMAIL_CONFIRMATION_REQUIRED`) where an anonymous user is asked to sign up (`SIGN_UP_REQUIRED`):

| Rule                                                 | Limit per rolling 7 days      | When hit                                                                                   |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| Per confirmed account                                | `QUOTA_LIMIT` (5, in `.env`)  | 429 `QUOTA_EXCEEDED`                                                                       |
| Per user before the email is confirmed, for good     | 1 (`PROVISIONAL_QUOTA_LIMIT`) | 429 `SIGN_UP_REQUIRED` / `EMAIL_CONFIRMATION_REQUIRED`                                     |
| Anonymous users and unconfirmed accounts per network | `IP_ANON_LIMIT` (3) in total  | 429 `SIGN_UP_REQUIRED` / `EMAIL_CONFIRMATION_REQUIRED`                                     |
| Everyone per network, soft                           | `IP_SOFT_LIMIT` (10)          | a Turnstile check for each further analysis: 403 `CHALLENGE_REQUIRED` / `CHALLENGE_FAILED` |
| Everyone per network, hard                           | `IP_HARD_LIMIT` (30)          | 429 `NETWORK_QUOTA_EXCEEDED`                                                               |

- **The network** is the IPv4 address or the IPv6 /64 prefix (an IPv4-mapped address counts as IPv4). The address is
  the `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS` from the right (1 on Cloud Run: the one Google's front end appends),
  or the socket address when the header is absent; never the leftmost entry, which the client controls
  ([`ClientNetworkResolver`](src/ip-quota/client-network.resolver.ts)). Each lookup logs only the header's entry count, at debug level.
- **Storage** ([`IpQuotaService`](src/ip-quota/ip-quota.service.ts)): one `ip_quotas` document per network, keyed by
  `HMAC-SHA256(key, network)`, the key derived from `BETTER_AUTH_SECRET` with HKDF. It holds
  `runs: { id, startedAt, jobId, anonymous }[]` (`anonymous`: counted against the anonymous allowance) and a TTL `expiresAt` 7 days after the last charge. The address itself
  is never stored or logged. A charge is one conditional pipeline update, as for the user quota; a refund is `$pull`
  by run id, found through an index on `runs.id`, so the worker needs no key.
- **Order** ([`AnalysisAdmission`](src/jobs/analysis-admission.service.ts)): `POST /v1/jobs` and `/from-sample` check
  the user cap and the network rules read-only; analyze charges the network, then the user. The job records both runs
  (`chargedRunId`, `chargedIpRunId`) before charging and clears them once both are refunded, so each is refunded at
  most once and never lost.
- **Failed analyses**: a run that ends without a result is never counted. Every failure refunds both runs, the
  user's and the network's, in full: a failure before the Gemini call, a call Vertex refused with an HTTP error
  status, a stuck worker, and a call that may have been billed alike. Once Gemini has answered, the call is billed
  even when the answer can't be used (cut off, blocked or malformed), and a call that timed out, lost its connection
  or failed unknowably may have been billed too, so Gemini is still called at most once per job: the job keeps the
  call mark (`modelCallStartedAt`, cleared only after a refusal). An answer that can't be used (cut off, a blocked
  prompt, malformed: `ModelAnswerError`) is never retried, since another attempt would be billed again, and its
  tokens are added to the job's `usage`. A job whose earlier attempt may have been billed (`modelCallStartedAt` set:
  the call timed out, lost its connection or got an answer) fails the same way.
- **Turnstile** ([`ChallengeVerifier`](src/challenge/challenge-verifier.ts)): the web runs the check when an analysis
  starts, for visitors without a confirmed account, and sends its token with the job creation; members send none unless the
  API answers `CHALLENGE_REQUIRED`, after which the web runs the check and creates the job again. The API calls Cloudflare's `siteverify` only when a rule
  asks for it (always for anonymous users and unconfirmed accounts), ignores a token no rule needs, and records `hasPassedChallenge` on the job
  for analyze. Without `TURNSTILE_SECRET_KEY` a required check never passes.
  A network that crosses the soft limit between creating and analyzing a job made without the check gets
  `CHALLENGE_REQUIRED` at analyze, and the user starts again.
- **Admins** (`isAdmin: true`) skip every network rule.

## Contact form

`POST /v1/contact` is public: anyone can write to the team, signed in or not. The message (at most 2,000 characters,
adlens-shared `CONTACT_MESSAGE_MAX_LENGTH`) goes to `CONTACT_EMAIL` through Resend with the visitor as Reply-To, so
answering is a plain reply; its text isn't stored.

- **The email is built for a busy support inbox** ([`contact-email.ts`](src/contact/contact-email.ts)):
    - Its sender name is the sender's address, so the inbox list names the person; the address stays MAIL_FROM's.
    - Its subject is `[AdLens] <the message's first line, cut at 60 characters> · ref <ref>`: the prefix for filters, the
      preview for triage, and a reference that keeps each message in its own thread. The same reference is logged.
    - The message comes first, then the facts: who wrote, their account (access, id, created, its own address when it
      isn't the reply address), analyses in the last 7 days, their last analysis (id, status, error code), their browser
      and system, the screenshots, and the reference with the API revision (`K_REVISION`).
    - The facts come from the request's session, if any ([`ContactSenderReader`](src/contact/contact-sender.ts)). Reading
      them never fails the message: the email then says the account couldn't be read. The IP address is never included.
- **Honeypot**: the form hides a `website` field; a message that fills it in answers 204 and sends nothing.
- **Turnstile**: a message carries either a `challengeToken` or the `draftId` of its images (exactly one, else 400
  `VALIDATION_FAILED`). The token is verified with Cloudflare's `siteverify` before anything is counted (403
  `CHALLENGE_FAILED` when it doesn't pass), so requests that fail the check can't use up the caps.
- **Images**: up to 5 PNG, JPEG or WebP images, at most 8 MB each and 25 MB together (adlens-shared's `CONTACT_*`
  limits; 25 MB is about 33 MB once base64-encoded, under Resend's 40 MB per email). `POST /v1/contact/uploads`
  takes the declared files and a `challengeToken`, verifies it, counts the network's upload drafts (below), and
  answers `{ draftId, uploads }`: one signed, create-only upload per file, in order, bound to its declared size and
  type, at `contact/<draftId>/<index><ext>`. The draft (`contact_drafts`: the files' paths, names, types and sizes)
  lives an hour (TTL `expiresAt`) and stands in for the check **once**: sending it marks it used in one conditional
  update (`usedAt` null and not expired), so of two concurrent sends only one gets it; an unknown, used or expired
  draft answers 400 `VALIDATION_FAILED`. The API then reads every declared object from the bucket; one missing or
  differing in size or type answers 400 `VALIDATION_FAILED` and nothing is sent (503 `UNAVAILABLE` when storage
  can't be read). The images go out as attachments named after the visitor's file names, with the extension of their
  verified type. A draft is used up even when the message is then refused or can't be sent; the web uploads again.
- **What is kept**: the images stay in the bucket for **30 days** after upload (the `contact/` lifecycle rule in
  [`infra/lifecycle.json`](infra/lifecycle.json)), then are deleted; a draft is deleted an hour after it was made.
  Neither records the visitor's email or address.
- **Hourly caps** ([`ContactLimits`](src/contact/contact-limits.ts)): at most **3 messages per network**, **3 per
  sender email** and **20 in total**, and **3 upload drafts per network**, past which the API answers 429
  `RATE_LIMITED`. The network is the one the
  network limits use (`ClientNetworkResolver`). The total is the hard guarantee: senders choose their email and can
  switch networks, and the Resend quota is shared with confirmation and reset emails. Each cap is a counter in
  `rate_limits`, counted like Better Auth's rate limits by [`createRateLimitStorage`](src/auth/rate-limit-storage.ts):
  one atomic pipeline upsert, so concurrent messages can't exceed a cap, under `HMAC-SHA256` of the email or the
  network key, never the address, deleted by a TTL index when its hour ends. The hour starts with a counter's first
  message. The caps are counted narrowest first and only while each passes, so a message the network or sender cap
  refuses doesn't use up the total. A message is counted only once its attachments were accepted, so a refused upload
  doesn't cost the sender one.

## Authentication

[Better Auth](src/auth/auth.instance.ts) on the app's own Mongo connection: email and password, plus Google and GitHub:

- **Sessions are httpOnly, `SameSite=Lax` cookies.** The web app (`www.useadlens.com`) and the API (`api.useadlens.com`)
  share the parent domain (`COOKIE_DOMAIN`), so the cookie is first-party for both and no token ever sits in
  JavaScript-readable storage. Socket.IO authenticates its handshake with the same cookie, and accepts a handshake
  only from the web app's origins (CORS never applies to a WebSocket; a missing `Origin` is refused, since browsers
  always send one). The API's own session reads (`AuthService.getUserId`: the guard, admission, the socket handshake)
  never refresh a session, since the refreshed cookie would be dropped while the database row is extended; the web's
  `get-session` refreshes it.
- **Anonymous sessions** (Better Auth's `anonymous` plugin): the web signs a visitor in anonymously right before their
  first analysis, never on page load. An anonymous user is a real `user` document (`isAnonymous: true`, email
  `<id>@anonymous.placeholder.invalid`, which is never sent mail), so jobs, the quota, history, replay and Socket.IO
  work unchanged. When they sign up or sign in (`/sign-up/email`, `/sign-in/*`), `onLinkAccount` moves their jobs
  (`userId`), quota runs and presets to the account ([`AccountDataService.adopt`](src/account/account-data.service.ts);
  a preset whose name the account already uses gets a number, `Name (2)`, and the 20 limit isn't applied to the move),
  then the plugin deletes the anonymous user; a failed move answers 500 `ACCOUNT_LINK_FAILED` and leaves the history
  with the anonymous user (the move is safe to repeat). A confirmation link never links: it never creates a session. `/link-social` is refused (403
  `ACCOUNT_LINK_FAILED`) for an anonymous session (it could attach a provider and stay anonymous forever) and for an
  unconfirmed account. `/delete-anonymous-user` answers 404: it deletes through Better Auth's internal adapter and
  would skip the purge.
- **Abandoned anonymous users are deleted after a week.** Every time an anonymous session is created or refreshed
  (Better Auth refreshes a session at most once a day), a session hook stamps `lastSeenAt` on the user. The daily
  cleanup job ([`AnonymousCleanupService`](src/cleanup/anonymous-cleanup.service.ts)) deletes each anonymous user whose
  `lastSeenAt` (or, without one, `createdAt`) is more than 7 days old and who has no unexpired session: first its jobs,
  presets and uploads (`AccountDataService.purge`), then its sessions, accounts and the user document. A user whose
  purge fails stays and is tried again the next day. The stamp must live on the user because signing out ("Forget this browser")
  deletes the session.
- **Disposable email domains are refused at sign-up** (`DISPOSABLE_EMAIL`), from the maintained
  `disposable-email-domains-js` list. Google and GitHub sign-in are unaffected.
- **One account per mailbox** ([`email-alias.ts`](src/auth/email-alias.ts)): a sign-up whose address reaches the same
  mailbox as an existing account (`ann+2@gmail.com`, `a.n.n@gmail.com` or `ann@googlemail.com` next to `ann@gmail.com`;
  a `+tag` on any domain) answers like an address already in use (422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`), so
  aliases can't stack the weekly allowance. The check matches the stored addresses with a pattern built from the new
  one, so nothing extra is stored and existing accounts count. Anonymous users are ignored; Google and GitHub sign-in
  are unaffected.
- **Unconfirmed accounts sign in.** Sign-up signs the user in straight away and mails a confirmation link (valid 24
  hours, as the email says; a password-reset link, 1 hour), and an
  unconfirmed account can sign in again. Until it confirms its email (`emailVerified` on the user document) it's
  limited like an anonymous user (see [Abuse limits](#abuse-limits)) and can't link a provider, but unlike an
  anonymous user it's never deleted for inactivity. A sign-up with an address
  already registered answers Better Auth's 422 "user already exists": accepted, since signing in at sign-up can't
  hide it.
- **Google and GitHub sign-in** (OAuth, callbacks on this API: `/api/auth/callback/{google,github}`). A provider is
  on when both its client id and secret are set; half a pair stops the API at startup. A social sign-in links to an
  existing user with the same email only when the provider reports that email as verified **and** the user's own
  email is verified, so an unconfirmed sign-up can't be taken over. Google always shows its account picker.
  The providers' access, refresh and ID tokens are never stored: AdLens only needs to know who signed in.
- **Password reset** by emailed link (1-hour token); a reset revokes every existing session.
- **Emailed links open the web app** (`/confirm-email`, and `/?reset-password-token=` for a reset, which opens the
  reset form in the web's auth modal), never the API: users only see the site's domain, and the confirmation page calls
  `verify-email` from the browser once it loads, so mail scanners that fetch links without running JavaScript can't
  use the token up. **Only the account's own session confirms it**: a
  `hooks.before` on `/verify-email` reads the token's address the way Better Auth does (`verifyJWT` with the auth
  secret) and answers 401 `SIGN_IN_REQUIRED` without a session or with an anonymous one (the web asks the visitor to
  sign in and opens the link again), and 403 `EMAIL_MISMATCH` in another account's session; neither sets a cookie. A
  token Better Auth would refuse keeps its own error (`INVALID_TOKEN`, `TOKEN_EXPIRED`). Confirming creates no session
  (`autoSignInAfterVerification: false`), so a forwarded link can't sign anyone in; sessions aren't cached in the
  cookie, so the next `get-session` reads `emailVerified: true`.
- **Auth error codes**: besides adlens-shared's `RequestErrorCode`s (such as `DISPOSABLE_EMAIL`), Better Auth answers
  a few codes of AdLens's own that only the web reads, in its own error body (`code`):
  [`auth-error-codes.ts`](src/auth/auth-error-codes.ts) holds `EMAIL_NOT_SENT`, `ACCOUNT_LINK_FAILED`,
  `SIGN_IN_REQUIRED` and `EMAIL_MISMATCH`.
- **Account deletion** (password-confirmed, or within a day of signing in for users without a password) purges the
  user's jobs, presets and every uploaded object (including videos of jobs adopted from an anonymous session, which
  stay under that session's prefix) before Better Auth removes the account; the quota runs live on the user document, so Better
  Auth's own delete clears them.
- **An email that can't be sent fails the request.** Emails go through Resend from `mail.useadlens.com`. Better Auth
  runs its email callbacks in a way that only logs their errors, so the callbacks queue each message for the request
  and an `after` hook sends it: a failed send answers 503 `EMAIL_NOT_SENT` instead of a success the user would wait on
  forever. The cost is that a password-reset request for an existing address takes a Resend round trip longer than one
  for an unknown address. The endpoint's work stands: a sign-up whose confirmation email failed has still created the
  account, and its 503 still sets the session cookie, since Better Auth merges the endpoint's response headers into an
  after hook's error. The user is signed in, unconfirmed, and can resend the email (`/send-verification-email`).
- **At most 5 confirmation and 5 reset emails per address per hour**, whoever asks. Anyone can ask for an unconfirmed
  account's link again (`/send-verification-email`), so without a cap anyone could flood an inbox and use up the day's
  Resend quota. The count
  lives in `rate_limits` under a keyed hash of `email|<kind>|<address>`, never the address. Past the cap nothing is
  sent and the request answers as usual; a failed count lets the email through.
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

Every `/v1/*` route except `GET /v1/samples`, `GET /v1/demos` and `POST /v1/contact` (and `/uploads`) requires a session; [`SessionGuard`](src/auth/session.guard.ts) resolves the user from the Better Auth
session cookie (never from the body) and every query is scoped by it. Errors share one shape,
`{ statusCode, errorCode, message, issues? }`, with `errorCode` from `adlens-shared`; a body that isn't valid JSON (400),
is over 1 MB (413) or comes in an unsupported charset or encoding (415) answers `VALIDATION_FAILED` with that status.

| Method & path               | Purpose                                                                                                                                                                                                           | Returns                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ALL /api/auth/*`           | Better Auth (public)                                                                                                                                                                                              | Better Auth                                          |
| `GET /health`               | Liveness (public)                                                                                                                                                                                                 | `{ status, service, time }`                          |
| `POST /v1/jobs`             | Admission check (optional challengeToken), then a pending job and its signed upload target                                                                                                                        | `{ job, upload }`                                    |
| `POST /v1/jobs/from-sample` | Admission check, then a pending job on a published sample ad (no upload)                                                                                                                                          | `{ job }`                                            |
| `POST /v1/jobs/:id/analyze` | Verify → charge network and user → count the run for its `presetId` when the settings still match it (never fails the start) → dispatch                                                                           | **202** `{ job }`                                    |
| `GET /v1/jobs`              | The caller's jobs, newest first (`?limit=` ≤ 50, `?cursor=`)                                                                                                                                                      | `{ jobs, nextCursor }`                               |
| `GET /v1/jobs/:id`          | One owned job                                                                                                                                                                                                     | `{ job }`                                            |
| `GET /v1/jobs/:id/video`    | A 15-minute signed URL for replaying the verified upload (404 `NOT_FOUND` once the cleanup deleted it)                                                                                                            | `{ url, expiresAt }`                                 |
| `DELETE /v1/jobs/:id`       | Delete a finished or unstarted job and its uploaded video (409 `JOB_IN_PROGRESS` while it runs)                                                                                                                   | **204**                                              |
| `GET /v1/me/quota`          | The caller's quota window                                                                                                                                                                                         | `{ quota }`                                          |
| `GET /v1/presets`           | The caller's saved analysis presets (the `presets` collection: one document per user, at most 20), default flag and usage included                                                                                | `{ presets }`                                        |
| `POST /v1/presets`          | Save a preset. A taken name (ignoring case) is `409 PRESET_NAME_TAKEN` unless `overwrite: true`; a 21st is `409 PRESET_LIMIT_REACHED`                                                                             | **201** `{ preset }` (**200** when it overwrote one) |
| `PUT /v1/presets/:id`       | Edit a preset's name and settings (same refusals, `404 NOT_FOUND` for an unknown id)                                                                                                                              | `{ preset }`                                         |
| `PUT /v1/presets/default`   | Make a preset the default, or `{ presetId: null }` to clear it                                                                                                                                                    | **204**                                              |
| `DELETE /v1/presets/:id`    | Delete a preset (`404 NOT_FOUND` when it is gone)                                                                                                                                                                 | **204**                                              |
| `GET /v1/admission`         | Whether a new analysis would be admitted (public; a visitor without a session is judged as a new anonymous user): the same quota and network refusals as `POST /v1/jobs`, without charging or the Turnstile check | **204**, or the refusal                              |
| `POST /v1/contact/uploads`  | Signed uploads for a Contact form message's images (public, Turnstile-checked, rate-limited)                                                                                                                      | **201** `{ draftId, uploads }`                       |
| `POST /v1/contact`          | Email a Contact form message to the team (public, Turnstile-checked or with an upload draft, rate-limited)                                                                                                        | **204**                                              |
| `GET /v1/samples`           | Published sample ads with preview URLs (public)                                                                                                                                                                   | `{ samples }`                                        |
| `GET /v1/demos`             | Active, finished demo analyses with their summary and a video URL (public)                                                                                                                                        | `{ demos }`                                          |

## Ad-policy rules

Rules are data. The ruleset is authored **outside this repo**, as a JSON file in the shape of
[`ruleSetSchema`](src/rules/schema.ts), and the maintainer publishes it to MongoDB as an **immutable version**
(validated by the same Zod schema the worker parses it with; a version that already exists is refused). Each published
version comes with a summary of which app options reach each rule platform and the placements, regions and check types
in use, so the code's options can be checked against every new version. The worker serves the newest published
version via [`RulesetService`](src/rules/ruleset.service.ts), so a rules update needs no redeploy, and every analysis
records the `rulesetVersion` it ran with.

Selection ([`src/rules/index.ts`](src/rules/index.ts)) targets the job's settings: its **platforms** (YouTube also pulls
in Google Ads policy), its **markets** (global rules always apply; UK/EU/US rules only in their market) and, for
format-specific rules such as the 6-second bumper cap, its **placements**. A setting left empty stands for every value
(`resolveSettings`: every platform, every market, every placement of the chosen platforms), so leaving a setting empty
and choosing all of it select the same rules and send the same prompt, which lists the resolved values; the schema
requires a rule's placements to belong to its platforms, so every video rule is selected by some settings. Selected
rules are then routed by `modality`:

- `metadata` → checked in code against the measured media facts (duration, dimensions as displayed after the video's
  rotation, real object size); an aspect ratio can be one required ratio (`aspect_ratio_in`), a list
  (`aspect_ratio_one_of`, `params.ratios`) or a range (`aspect_ratio_between`, `params.min`/`max`, min not above
  max), written as `W:H` with both parts positive. Each check names those of its rule's platforms the chosen ones
  reach, the chosen placements a placement spec binds (both resolved as above, so a spec spanning Meta and YouTube
  names only Meta and Meta's placements on a Meta-only run; none for a spec that binds every placement), the rule as
  a sentence (`check`), and a `detail`
  sentence about the video ("It’s 30.4 seconds long, longer than the 6 seconds allowed."), so the report can say which
  placement the video won't work for. Durations are compared with a 0.1 s tolerance (a 6-second bumper probes at
  6.02–6.04 s), and shown with two decimals when one would round them to the limit. `resolution_min` is a minimum
  on the short side, `min(width, height)`, as the platforms state it per orientation; an optional `params.squareMin`
  raises it for a square video (TikTok in-feed: 540 px on the short side, 640×640 when square);
- `text` / `visual` / `audiovisual` → sent to the model as `{ id, check, severity, modality }`; quote and resolved
  source link are attached back by id (the ruleset schema refuses two rules with one id), ids the model invents are
  dropped, and a rule it answers twice keeps its first verdict;
- `out_of_creative` → an advisory checklist, never judged: the model only names the advisories whose subject the ad
  falls under (`advisories` in its output), and only those are stored. Content rules reach the model ordered by
  importance (blocker policies first, best-practice advice last).

Every analysis records `model`, `promptVersion` and `rulesetVersion`. For pricing, the job keeps every billed Gemini
call in `usage.calls` (time, model, location, traffic type, finish reason, and prompt, cached, tool-use, answer and
thinking tokens with their split by modality), failed attempts included, plus totals across them. Each call also
records `durationMs`, how long the model request took (a monotonic clock, our parsing excluded; `at` is when the answer
arrived), so cost changes can be checked against processing time; calls recorded before it was measured lack it. A call
that got no answer (an error status, a timeout) isn't recorded, but its logged failure says how long it ran.

## Sample ads

Sample ads let anyone try AdLens without an ad of their own. Each is a document in the `samples` collection (title,
description, storage path, media facts, suggested settings, display order, published flag), and its video is stored
under `samples/` in the uploads bucket. `GET /v1/samples` lists them with short-lived preview URLs; the web app fills
in the suggested settings, which the user can change, and `POST /v1/jobs/from-sample` creates a job that points at the
sample's video. Analyzing it skips upload verification (the video was measured when it was published); the only check
is that a published sample still points at that object. It is charged like any other analysis. Samples are
published by the maintainer: the video is measured with the same `MediaProber`, uploaded under `samples/`, and its
document upserted by slug.

Set `"isPublished": false` and publish again to hide a sample.

## Demos

The demo page shows a few finished analyses to anyone, so a visitor sees a report before spending their free run. A
demo is an ordinary job with a `demo` field (slug, tab label, summary title and subtitle, display order, active flag),
owned by `demo` (`DEMO_OWNER`), which matches no user: a demo is in nobody's History, no account can delete it, and the
daily cleanup never deletes its video, stored under `demos/` in the uploads bucket. `GET /v1/demos` lists the active,
analyzed demo jobs in order, each with its public job and a short-lived video URL. Only the latest analysis per demo
is listed: a re-run demo stays on the page with its earlier job until the new one is analyzed, and the earlier job
stays stored. Demos are managed by the maintainer: the video is measured
and uploaded, the job created as `queued` and handed to the analysis worker like any other, so it runs the production
pipeline and is billed like any run, outside every quota. Set `"isActive": false` and publish again to hide a demo.

## Layout

```
src/        main.ts (API), worker.ts (analysis worker) and cleanup.ts (daily cleanup), one Nest module per feature: jobs,
            analysis, rules, samples, demos, presets, quota, me, ip-quota, challenge, auth, account, contact, cleanup, mail, storage,
            realtime, database, config; shared helpers in common/, test helpers in testing/
test/       e2e (Supertest) and auth-flow tests
infra/      gcloud setup script, bucket CORS policy and lifecycle rule, image repository cleanup policy
```

## Environment

All variables are validated at startup by [`src/config/env.ts`](src/config/env.ts); a missing or malformed value stops
the process with a readable error. Locally they come from `.env` (non-secret, committed) and `.env.local` (secrets).
The image ships `.env` too, so a value set there (such as `QUOTA_LIMIT`) applies locally, to the API and to both jobs
alike; Cloud Run's own env vars take precedence over it, and `.env.local` is never shipped. In production, secrets come from one Secret Manager secret, `API_SECRETS`, mounted as a JSON file and merged into the
config before validation — see `SECRETS_FILE` below and [`infra/setup.sh`](infra/setup.sh).

| Variable                 | Default                                | Purpose                                                                                                                                                          |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRETS_FILE`           | —                                      | Path to a mounted JSON file of secrets; unset locally. Its keys fill gaps in the environment, never override it                                                  |
| `MONGODB_URI`            | required                               | Atlas connection string (Mongoose, Better Auth, Change Stream)                                                                                                   |
| `GOOGLE_CLOUD_PROJECT`   | required                               | GCP project for Vertex and Cloud Run                                                                                                                             |
| `STORAGE_BUCKET`         | required                               | The uploads bucket                                                                                                                                               |
| `PUBLIC_MEDIA_BUCKET`    | —                                      | Publicly readable bucket of demo and sample videos, served at their plain address; unset, they are signed                                                        |
| `BETTER_AUTH_SECRET`     | required by the API                    | Better Auth signing secret                                                                                                                                       |
| `BETTER_AUTH_URL`        | `http://localhost:8080`                | The API's own public URL                                                                                                                                         |
| `WEB_ORIGIN`             | `http://localhost:3000`                | Web origin for CORS, Socket.IO, Better Auth and email links; a `localhost` origin also allows the next 5 ports (a dev server that finds its port taken moves on) |
| `COOKIE_DOMAIN`          | —                                      | Parent domain for the session cookie in production (`useadlens.com`)                                                                                             |
| `RESEND_API_KEY`         | required by the API                    | Resend sending key; the API won't start without it                                                                                                               |
| `CONTACT_EMAIL`          | required by the API                    | Where Contact form messages go; the API won't start without it                                                                                                   |
| `GOOGLE_CLIENT_ID`       | —                                      | Google sign-in; enabled with `GOOGLE_CLIENT_SECRET` (both or neither)                                                                                            |
| `GOOGLE_CLIENT_SECRET`   | —                                      | Google OAuth client secret                                                                                                                                       |
| `GITHUB_CLIENT_ID`       | —                                      | GitHub sign-in; enabled with `GITHUB_CLIENT_SECRET` (both or neither)                                                                                            |
| `GITHUB_CLIENT_SECRET`   | —                                      | GitHub OAuth client secret                                                                                                                                       |
| `MAIL_FROM`              | `AdLens <no-reply@mail.useadlens.com>` | Sender of auth emails                                                                                                                                            |
| `PORT`                   | `8080`                                 | API listen port                                                                                                                                                  |
| `LOG_FORMAT`             | `text`                                 | `json` on Cloud Run: one Cloud Logging entry per line, with `severity`                                                                                           |
| `STORAGE_KEY_FILE`       | —                                      | Local only: SA key used to sign V4 URLs (user ADC can't sign)                                                                                                    |
| `GCP_REGION`             | `europe-west1`                         | Region of the analysis Cloud Run Job                                                                                                                             |
| `ANALYZE_JOB_NAME`       | `adlens-analyze`                       | The Cloud Run Job the API executes                                                                                                                               |
| `ANALYZE_LOCAL`          | `0`                                    | `1`: run each analysis as a local `node dist/worker` child process                                                                                               |
| `ANALYZE_MAX_RETRIES`    | `2`                                    | Must equal the job's `--max-retries`, so the worker knows its last attempt                                                                                       |
| `QUOTA_LIMIT`            | — (required, `5` in `.env`)            | Analyses per rolling 7-day window for a confirmed account (before confirmation a user gets 1 in total)                                                           |
| `IP_ANON_LIMIT`          | `3`                                    | Analyses by anonymous users and unconfirmed accounts per network in a rolling 7-day window                                                                       |
| `IP_SOFT_LIMIT`          | `10`                                   | Analyses per network before everyone needs a Turnstile check                                                                                                     |
| `IP_HARD_LIMIT`          | `30`                                   | Analyses per network, for everyone                                                                                                                               |
| `TRUSTED_PROXY_HOPS`     | `1`                                    | Proxies that append to `X-Forwarded-For` (1 on Cloud Run)                                                                                                        |
| `TURNSTILE_SECRET_KEY`   | —                                      | Cloudflare Turnstile secret; unset, a required check never passes                                                                                                |
| `GEMINI_MODEL`           | `gemini-3.8-flash`                     | Model id                                                                                                                                                         |
| `GEMINI_LOCATION`        | `global`                               | Vertex serving location                                                                                                                                          |
| `WORKER_JOB_ID`          | —                                      | Worker only: set per execution by the dispatcher                                                                                                                 |
| `CLOUD_RUN_TASK_ATTEMPT` | `0`                                    | Worker only: set by Cloud Run on each attempt                                                                                                                    |

## Local development

```bash
gcloud auth application-default login   # once; the account needs Vertex AI User
npm install
# .env.local: MONGODB_URI, BETTER_AUTH_SECRET, RESEND_API_KEY, CONTACT_EMAIL, ANALYZE_LOCAL=1, STORAGE_KEY_FILE, TURNSTILE_SECRET_KEY
npm run start:dev                        # keeps dist/ built, which the local worker process runs
```

With `ANALYZE_LOCAL=1` each analysis runs `node dist/worker` as a child process, the same entry point Cloud Run runs.
Vertex reads the real `gs://` object, so a real bucket and ADC are needed for the analysis step.

A restart of the watch mode kills that child process, and on Windows a mere read of a dependency (the worker loading
its own) reaches TypeScript's file watcher as a change. So `tsconfig.json` `watchOptions` polls files, which compares
modification times, and doesn't watch `node_modules`: restart `npm run start:dev` yourself after `npm install`.

Locally, use Cloudflare's test secret 1x0000000000000000000000000000000AA (always passes) with the web's test site
key; 2x0000000000000000000000000000000AA always fails.

## Tests

```bash
npm test          # unit: quota, network quota, Contact limits, job lifecycle, pipeline, verification, client IP, Better Auth indexes (real MongoDB via mongodb-memory-server)
npm run test:e2e  # Supertest against the Nest app with fake storage, prober, dispatcher and auth
npm run test:auth # after a build: sign-up, verification, reset, deletion, anonymous linking and rate limits against the real Better Auth
```

`npm run knip` (also in CI) reports unused files, exports and dependencies, which ESLint can't see across files. Its
config (`knip.json`) lists the three entry points (`main.ts`, `worker.ts`, `cleanup.ts`); add any new one there. It
also lists the e2e and auth-flow tests itself, with Knip's Node.js plugin off: that plugin takes every `test-*` file
for a `node --test` entry, so the unused exports of a helper like `src/testing/test-ruleset.ts` went unreported.

The unit tests run the Mongo-dependent logic against a real in-memory MongoDB, because the guarantees that matter
(conditional transitions, concurrent charges, at-most-once refunds) live in query semantics that mocks can't prove.

## Deployment

Every push to `init-setup` that passes CI deploys to production
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The `deploy` job signs in to Google Cloud with Workload
Identity Federation: GitHub's OIDC token is exchanged for a short-lived credential, no service account key exists, and
only this repository's pushes to `init-setup` are accepted. It builds one image, pushes it to Artifact Registry, rolls
the `adlens-analyze` and `adlens-cleanup` jobs and then the `adlens-api` service to that digest, and ends with a health check.

[`infra/setup.sh`](infra/setup.sh) (plain gcloud, see [Design decisions](#design-decisions)) creates
everything the workflow relies on: the APIs, the bucket, its CORS policy from [`infra/cors.json`](infra/cors.json) and its lifecycle rule from
[`infra/lifecycle.json`](infra/lifecycle.json) (Contact form attachments are deleted after 30 days),
the runtime and deploy service accounts, the Workload Identity provider, the `API_SECRETS` bundle, the image
repository and the Cloud Scheduler job that starts `adlens-cleanup` daily. It also owns the runtime config (env vars,
secrets, the analysis job's 2 retries and 15-minute timeout, the cleanup job's schedule), which CI
leaves untouched, and can deploy the current checkout by hand. The API is served at `https://api.useadlens.com`
through a Cloud Run domain mapping.

To create or rotate a secret, put any subset of `MONGODB_URI`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`,
`CONTACT_EMAIL`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET` and `TURNSTILE_SECRET_KEY` in `.env.production` at the
repo root (`KEY=value` per line, values taken literally; ignored by git, the Cloud Build upload and the image like
every `.env.*` file, and the script refuses to run if it's tracked), then run the script. It's a separate file from
`.env.local` on purpose: local values such as Turnstile's always-pass test key must never reach production. The script
prints the source of every key (`.env.production`, the bundle, a legacy secret, or absent — never a value) and asks
for confirmation before writing, merges the file's values into the `API_SECRETS` bundle (a key the file doesn't set
keeps its current value), and deploys both jobs and the API, each mounting `API_SECRETS` at `/secrets/api.json`
(`SECRETS_FILE`). All three run as the same runtime service account today, so all mount the whole bundle even though
the jobs only read `MONGODB_URI` from it. To remove a key from the bundle entirely, edit it by hand
(`gcloud secrets versions access latest --secret=API_SECRETS`, edit the JSON, then
`gcloud secrets versions add API_SECRETS --data-file=edited.json`) — the script only ever adds or overwrites keys,
it never drops one on its own. A key removed this way comes back on the next run of the script if its legacy
individual secret still exists: the script's source order is `.env.production`, then the bundle, then the legacy secret of
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
- **Realtime through Socket.IO fed by a Change Stream**, one watcher per API instance: every instance sees every
  update and pushes it to its own sockets, so the instances (up to 3) need no shared Socket.IO adapter while updates
  come only from the database.
- **Gemini on Vertex AI with Application Default Credentials**, so no API key exists. Gemini 3 models are served from
  the `global` location.

**Correctness**

- **One owner for job status.** `JobLifecycle` performs every transition as a conditional update on the expected
  current status. Status written from several places allowed double charges and dispatches, regressions from
  `analyzing` to `queued`, and jobs stuck in progress after a crashed worker.
- **Charge when queued, refund at most once, never lose a refund.** The atomic charge is the gate; charging only after
  success would let concurrent requests pass a non-consuming check. The job records the run ids before charging and
  keeps them until both refunds succeed, and every refund is idempotent per run id, so a crash or a transient error
  anywhere leaves ids on an ended job for a later sweep, and two refunders can never take a run back twice. Clearing
  the ids in the write that ended the run, as before, lost the refund to any failure after that write.
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
  failures exit 1 while attempts remain; permanent ones, or the last attempt, end the job. A retry calls Gemini again
  only if no earlier call may have been billed (none was made, or Vertex refused it): a malformed answer used to get
  one retry (generation is stochastic), but that billed the job twice, so since 2026-10-01 an unusable answer fails
  the job at once, and so does any other possibly billed call, transient or not. `maxOutputTokens` caps what the one
  call can cost.
- **A run that ends without a result is never counted.** Until 2026-10-02 a network had 3 refunds a week
  (`IP_FAILURE_REFUND_LIMIT`) of failures after a possibly billed call, past which the failed run stayed counted for
  the user and the network, so a video that always fails couldn't be re-run for free. It was removed so that nobody
  is charged for a run that gave them nothing: every failure is refunded in full. Gemini is still called at most once
  per job, and the Vertex spend cap bounds what repeated failures can cost.
- **Gemini 3 runs at its default temperature.** Google advises keeping Gemini 3 at 1.0; a temperature of 0.2 made it
  loop into an 18k-token malformed reply in testing.
- **Verification trusts the stored object, not the client.** Size and type come from object metadata and ffprobe, and
  the signed upload URL binds the exact declared size and can only create the object, never overwrite it. Only a definite problem with the file deletes it; storage or
  network trouble ends the job as `VIDEO_CHECK_FAILED` and leaves the file to the daily cleanup. ffprobe reads only
  the accepted containers (`-format_whitelist`; a playlist or manifest uploaded as MP4 would otherwise make it fetch
  the URLs inside, and is rejected as unreadable instead), runs with `PATH` as its only environment (never the API's
  secrets), and its errors are logged without the signed URL's query, which is a working read credential.
- **A failed start ends the job; it never goes back to `pending`.** Until 2026-10-02 a missing upload, a storage or
  prober failure, a sample gone, a refused charge or a worker that couldn't be started put the job back to `pending` so
  the same job could be started again. The web never does that (it creates a new job for every run), so those jobs
  stayed `pending` for good. Each now ends in `error` with a code saying why, while the HTTP answer stays the same.
- **Lazy expiry, backed by the daily cleanup.** Abandoned jobs are expired when their owner next reads their jobs, so
  what they see is never stale, and the daily cleanup expires everyone's, so a job whose owner never comes back
  doesn't keep its charges for the whole 7-day window. Both run the same `JobLifecycle` transitions.
- **Tests run against a real MongoDB** (`mongodb-memory-server`), because the guarantees above live in query semantics
  that mocks can't prove. Auth flows run against the real Better Auth, which Jest can't load (ESM), under Node's test
  runner.

**Contract and rules**

- **The contract package holds only the contract.** `adlens-shared` publishes request, response and public job
  schemas. The stored job is composed here from those blocks plus server-only fields (owner, storage path, execution,
  accounting), so they never reach a client. It is published by CI and pinned exactly, because a `file:` link only
  works on one machine.
- **Rulesets are immutable, versioned data in MongoDB.** Publishing validates with the worker's own schema and refuses
  an existing version, so a rules change needs no deploy and every analysis records its `rulesetVersion`. A
  maintainer's script was chosen over an admin endpoint, which would need an admin identity model. The ruleset
  file isn't kept in this repo: rules are content, maintained outside it, and tests use a small fixture
  (`src/testing/test-ruleset.ts`) copied from real rules.
- **Rules target placements and markets, not just platforms.** Format caps such as the 6-second bumper apply only to
  their placement, and UK/EU/US rules only in their market; the schema refuses a rule whose
  placements don't belong to its platforms, so every video rule is reachable by some settings.
- **Nothing chosen means nothing ruled out, for every setting.** Placements used to be opt-in, so an analysis with
  every setting left empty got no placement specs and no placement-bound policies, unlike the same ad with everything
  chosen (2026-10-08: 2 findings and 1 spec against 6 and 18). Now an empty list resolves to every value before rules
  are selected and before the prompt is written (prompt version 9).

**Auth and hosting**

- **Anonymous users are real Better Auth users**, created only when a visitor starts an analysis, so every existing
  path (jobs, quota, history, Socket.IO) works unchanged and crawlers create none. Once nobody can reach one (its
  session expired or was signed out), the daily cleanup deletes it a week after it was last seen.
- **One analysis without an account, then sign up; one without a confirmed email, then confirm.** It's the
  2026-08-13 design (first analysis anonymous, an account from the second), applied on 2026-10-01; anonymous users
  had had the members' 3 a week since 2026-09-28. Clearing cookies gets a new anonymous user, so the per-network
  anonymous allowance (`IP_ANON_LIMIT`, kept at 3 a week so several people on one office or mobile network can each
  try once) stays the real bound. An unconfirmed account is limited the same way: otherwise signing up with any
  address, which now signs in at once, would skip both limits. Since 2026-10-08 the one analysis is shared by the
  anonymous user and the account and kept for good (`freeRunId`), and any analysis marks the browser: before that, a
  run before sign-up and one before confirmation made two, and the allowance came back after a week.
- **Demo and sample videos live in a public bucket.** They're public content, so `GET /v1/demos` and `GET /v1/samples`
  answer their plain address in `PUBLIC_MEDIA_BUCKET` instead of a 15-minute signed URL: no IAM `signBlob` call per
  video per request, no player failing after 15 minutes on the page, and a stable URL browsers can cache. It's a
  separate bucket because GCS refuses a public grant limited to a prefix ("Conditions are not allowed on public
  resources", tested 2026-10-09) and the uploads bucket holds every user's video. A sample job's replay URL follows its
  file's bucket the same way; everything else is still signed against its own bucket.
- **Linking moves ownership, not objects.** `jobs.userId` is rewritten and the runs are merged, but the GCS objects stay
  where they were uploaded: copying each video inside the sign-in request would be slow and could half-fail, and the
  verifier, replay URLs and worker already read `file.path`. So deleting a job deletes its `file.path`, and the purge
  deletes adopted uploads before the account's own prefix. The purge must stay in `deleteUser.beforeDelete`: the
  anonymous plugin deletes a linked anonymous user through the internal adapter, which skips it. That delete only logs
  a failure, so a linked anonymous user can survive and be purged later by the cleanup: a purge keeps every object
  under the user's prefix that another user's job still references.
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
  to this repository's `init-setup` branch by numeric ids, so no long-lived key exists. Both jobs and the API are
  rolled to the same digest, the jobs first. CI only swaps the image; runtime config stays in `infra/setup.sh`.
- **Infrastructure as a gcloud script.** The infrastructure is a handful of set-once resources, so an idempotent,
  committed script is enough; Terraform or Pulumi would be the step up if it grows.
- **One Secret Manager secret for all of the API's secrets.** The free tier caps active secret _versions_ per billing
  account, and every secret is at least one version; one JSON bundle (`API_SECRETS`) uses a single version however
  many keys it holds, and costs one access per instance start instead of one per secret. The trade-off is no per-key
  IAM binding — anything that can read the bundle can read every key in it — which is fine while the API and the
  worker share one runtime service account; split into per-identity secrets when the worker gets its own.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md): free to read, run and learn from, not for commercial use. The analysis
lab ([adlens-lab](https://github.com/haggifer/adlens-lab)) and the contract package
([adlens-shared](https://github.com/haggifer/adlens-shared)) are MIT.
