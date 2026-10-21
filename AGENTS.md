# AGENTS.md

Guidance for coding agents working in this repository. Read [README.md](README.md) first: it covers the architecture,
the job lifecycle, the environment and the design decisions behind them.

## Commands

```bash
npm run build            # nest build → dist/ (the API and the worker)
npm run start:dev        # API with watch; keeps dist/ current for the local worker (ANALYZE_LOCAL=1)
npm run lint
npm run knip             # unused files, exports and dependencies (knip.json; list new entry points there)
npx tsc --noEmit -p tsconfig.json
npm test                 # unit tests (real MongoDB via mongodb-memory-server)
npm run test:e2e         # Supertest against the app with fake storage, prober, dispatcher and auth
npm run test:auth        # after `npm run build`: real Better Auth flows under Node's test runner
npm run db               # after `npm run build`: dry run of the database job against .env.local (production)
```

## Rules that must not break

- **Ruleset updates start a sync, and only they do.** When the maintainer publishes a new ruleset version, it comes
  with a summary of the options and values it uses. Then check that summary against the code in the same change set:
  every rule platform reachable from an app option (`RULE_PLATFORMS` here; the web's `PLATFORM_LABELS`), every
  placement and region offered as an option (adlens-shared `Placement`, `Market`; the web's `PLACEMENT_LABELS`,
  `MARKET_LABELS`), every check type supported by the deployed API (deploy the API before publishing a ruleset that
  needs a new one). Other changes don't need this.
- A job is created `pending`; after that, `JobLifecycle` is the only code that changes its status, and every transition
  is a conditional update on the expected current status. Don't write `status` anywhere else.
- A job never goes back to `pending`: the web never starts a job twice (it creates a new one), so a start that fails
  ends the job in `error` with a `JobErrorCode` saying why, any charge refunded, while the HTTP answer keeps its own
  code.
- A run that ends without a result is never counted: every failure refunds the user's run and the network's in full,
  even after a Gemini call that may have been billed. Gemini is still called at most once per job (the
  `modelCallStartedAt` mark), so that refund never pays for a second call.
- `GET /v1/admission` and job creation share `AnalysisAdmission`'s rule checks (`preview` and `admit`): a new refusal
  goes into those checks, never into one path only, so the web's advance check matches what creating a job answers.
- A quota charge is refunded at most once and never lost. The job records the run ids (`chargedRunId`,
  `chargedIpRunId`) before charging and keeps them until both refunds succeed; every refund is safe to repeat (`$pull`
  by run id), and ended jobs still holding ids are retried by `refundOwedCharges` (on every read of the user's jobs
  and in the daily cleanup). Never clear those ids before the refunds succeed. Never store a network key or an address
  on a job.
- The client's address comes only from `ClientNetworkResolver` (`X-Forwarded-For` read `TRUSTED_PROXY_HOPS` from the
  right). Never store or log an address; networks are stored as an HMAC.
- Better Auth resolves the address itself for its rate limits and sessions; keep `advanced.ipAddress.trustedProxies`,
  which makes it take the same rightmost `X-Forwarded-For` entry (`src/auth/auth-proxies.ts`; the API refuses to start
  with another `TRUSTED_PROXY_HOPS` until that list names the extra proxies).
  Keep its counters in `createRateLimitStorage` (HMAC keys, TTL-deleted), never `rateLimit.storage: 'database'` (raw
  `<ip>|<path>` keys, never deleted), and keep the `session.create.before` hook that sets `ipAddress` to null.
- Indexes are created only by the database job (`src/db.ts`, `adlens-db`), which the deploy runs last: declare a new
  one on its schema (or in `AUTH_INDEXES` for Better Auth's collections, whose adapter creates none) and never create
  one on start (`DatabaseModule` keeps `autoIndex` and `autoCreate` off). The job never drops an index; an extra one
  is the maintainer's to hide, watch and drop. Keep Better Auth's index names, and never log a MongoDB error message
  there: a duplicate-key message quotes the value, an email address.
- A change to stored data's shape is a migration in `MIGRATIONS` (`src/db-job/migrations.ts`), never a script outside
  the repo. It ships with code that reads both the old and the new shape, must be safe to run again, and uses raw
  updates, which leave `updatedAt` alone (the stale-job sweep reads it). Drop the old shape's reading in a later
  change, once the deploy that ran the migration has succeeded and the job reports 0 refused documents there. Once a
  migration has run, roll back (a job or the API) only to a commit that reads the new shape.
- Every model is built with `zodToMongoose`, whose Zod schema is also its collection's validator (`syncValidators`):
  a stored shape the Zod schema refuses is either a bug or needs a migration. Validators are in `warn` mode; switch a
  collection to `error` only after the job has reported 0 refused documents for it.
- A confirmation link confirms only in the session of the account it was sent to (the `/verify-email` before hook:
  `SIGN_IN_REQUIRED` without one or with an anonymous one, `EMAIL_MISMATCH` for another account) and never creates a
  session (`autoSignInAfterVerification: false`): a link reaches whoever it is forwarded to.
- A mailbox has at most one confirmed account: only a confirmed account blocks an alias at sign-up, and `/verify-email`
  refuses to confirm a second account on a mailbox (`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`).
- The Contact form's caps are atomic counters in `rate_limits` (`ContactLimits` over `createRateLimitStorage`, hashed
  keys), counted only after the Turnstile check or the draft passed and the draft's images were accepted; never
  count-then-insert. A Contact draft stands in for one Turnstile check: it is used by one conditional update (`usedAt`
  null, not expired) and never reused.
- An account's purge runs in Better Auth's `user.deleteUser.beforeDelete`, never in `databaseHooks.user.delete`: the
  anonymous plugin deletes a linked anonymous user through the internal adapter after its jobs moved to the account,
  and their videos still sit under the anonymous user's prefix.
- A job's upload is at `file.path`, which after linking can be under another user's prefix. Delete by that path; never
  derive it from `userId`.
- adlens-lab imports this source only through `src/lab.ts`. Keep what it exports working for the lab; a symbol the lab
  needs is added there, never imported by path from elsewhere in `src/`.
- A write that changes a user's presets, or updates a job's status, analysis, error or counted preset, tells the user's
  tabs through `LivePublisher` right after it (`JobLifecycle`, `PresetsService`, `JobsService.recordCountedPreset`); a
  new writer of those does too. Only updates are announced, not jobs created, deleted or moved at sign-in. A live message only names what changed (`LiveEvent`, a job id), never its data, and a
  failed publish never fails the write.
- Clients only ever receive the public job shape from `jobs/job.mapper.ts`; owner, storage path, execution and
  accounting fields stay server-side.
- The request, response and error shapes come from `adlens-shared`. Change the contract there first, publish it, then
  bump the exact pin here. Never commit a `file:` dependency.
- **Contract changes deploy in order.** The shared request schemas are strict, so an API that doesn't know a field
  refuses it (`VALIDATION_FAILED`). A new request field ships with the API first (deployed and healthy on `/health`),
  then the web; a rollback goes in reverse, the web first, then the API. A response field the web reads stays optional
  on the web until the API that sends it is live. The same order holds for rulesets (see Gotchas): the API that knows a
  new value first, then what uses it.
- All configuration goes through the Zod schema in `src/config/env.ts`. Tests set `NODE_ENV=test` (Jest's setup file
  `test/test-env.ts`, whatever the shell says), which stops env files from loading, so tests can never reach a real
  database or bucket.
- Production secrets go in the `API_SECRETS` Secret Manager bundle, via `infra/setup.sh` (put the key in the git-ignored
  `.env.production`, never `.env.local`, and run the script) — never as their own individual secret, and never as a plain env var in a deploy command.
- The committed `.env` ships in the production image: only public values meant for every environment go there (it is
  where `QUOTA_LIMIT` is set). Local-only values go in `.env.local`, secrets in the bundle above.
- `ANALYZE_MAX_RETRIES` must equal the Cloud Run Job's `--max-retries` in `infra/setup.sh`.
- One job, one worker execution. An upload job's worker is dispatched at creation, after the job holds
  `workerWaitsUntil` (never the other way round), and only while the user has no other job waited for by one. Only the
  write that queues the job decides whether that worker keeps the job (`isLeftToEarlyWorker`, from stored values): it
  sets `leftToEarlyWorker` exactly when the start dispatches none. A worker dispatched early runs only a job in flight
  with that flag, never on the deadline's presence alone (an API without the flag leaves it in place and dispatches);
  its waiting never changes the job, and a wait that ends without running exits 0. Its own clock only ever makes it
  leave a job still pending or verifying. `EARLY_WORKER_WAIT_MS`, the boot and the 10-minute Gemini request must fit
  the 15-minute task timeout. The early dispatch is capped (`EARLY_DISPATCH_TIMEOUT_MS`) and never fails a create.
- Never delete a user's upload on a transient storage or network error; only a definite problem with the file
  deletes it.
- A job with a `sampleId` points at a shared sample video under `samples/`: it skips upload verification, and nothing
  that cleans up jobs or accounts may ever delete that object.
- A job with a `demo` field (owner `DEMO_OWNER`) points at a maintainer video under `demos/`: no cleanup may delete that
  object, and no route may let a user see, list or delete the job except `GET /v1/demos`.

## Conventions

- Formatting is Prettier (`.prettierrc`); linting is ESLint. Format only the files you touch.
- Comments explain why, not what.
- Commits follow Conventional Commits (`feat(scope): …`, `fix: …`, `docs: …`), one commit per distinct change.
- When a change affects a command, env variable, rule above or design decision, update README.md or this file in the
  same commit.

## Gotchas

- Every push to `init-setup` that passes CI deploys to production.
- The worker validates each published ruleset with its own schema, so a ruleset using a new `checkType` (or any new
  schema value) must be published only after the API that knows it is deployed; otherwise every analysis fails.
- Jest can't load Better Auth's ESM build, so the e2e suite stubs it; real auth behaviour is covered by `test:auth`.
- Better Auth needs MongoDB transactions, so `test:auth` runs on an in-memory replica set; the unit and e2e tests use
  a standalone in-memory server.
- Better Auth only rate-limits when `NODE_ENV` is `production`; `test:auth` switches it on for single tests through
  `auth.$context` (`withRateLimits`).
- With `ANALYZE_LOCAL=1` the API spawns `node dist/worker`, so `dist/` must be built.
- A user document without `emailVerified: true` is an unconfirmed account, limited like an anonymous user
  (`getUserAccess`), so a test member needs `emailVerified: true`.
- The e2e suite sets `BETTER_AUTH_SECRET` in `test/global-setup.ts`: the network key is derived from it. It fakes the
  Turnstile verifier (`'pass'` passes), and `X-Forwarded-For` picks each test's network.
- An index that fails to build fails the database job, and so the deploy's last step, after the API is already live:
  its log line `index <collection>.<name>: could not be created` names it. Migrations run before indexes in the
  same job, so a migration can make the data fit a new unique index.
- Before upgrading Better Auth, diff its table-level `indexes` against `AUTH_INDEXES`: an index on the same key with
  a different name or options raises `IndexOptionsConflict` in the adapter's `ensureModelIndexes`, which runs before
  every write, so every write would fail.
