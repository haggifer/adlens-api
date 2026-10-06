# AGENTS.md

Guidance for coding agents working in this repository. Read [README.md](README.md) first: it covers the architecture,
the job lifecycle, the environment and the design decisions behind them.

## Commands

```bash
npm run build            # nest build → dist/ (the API and the worker)
npm run start:dev        # API with watch; keeps dist/ current for the local worker (ANALYZE_LOCAL=1)
npm run lint
npx tsc --noEmit -p tsconfig.json
npm test                 # unit tests (real MongoDB via mongodb-memory-server)
npm run test:e2e         # Supertest against the app with fake storage, prober, dispatcher and auth
npm run test:auth        # after `npm run build`: real Better Auth flows under Node's test runner
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
- Better Auth resolves the address itself for its rate limits and sessions. Keep its counters in
  `createRateLimitStorage` (HMAC keys, TTL-deleted), never `rateLimit.storage: 'database'` (raw `<ip>|<path>` keys,
  never deleted), and keep the `session.create.before` hook that sets `ipAddress` to null.
- Better Auth's collections get their indexes only from `AUTH_INDEXES` in `src/auth/auth-indexes.ts` (its adapter
  creates none), created on API start and logged, never fatal, on failure. Keep Better Auth's index names, and never
  log a MongoDB error message there: a duplicate-key message quotes the value, an email address.
- A confirmation link confirms only in the session of the account it was sent to (the `/verify-email` before hook:
  `SIGN_IN_REQUIRED` without one or with an anonymous one, `EMAIL_MISMATCH` for another account) and never creates a
  session (`autoSignInAfterVerification: false`): a link reaches whoever it is forwarded to.
- The Contact form's caps are atomic counters in `rate_limits` (`ContactLimits` over `createRateLimitStorage`, hashed
  keys), counted only after the Turnstile check or the draft passed and the draft's images were accepted; never
  count-then-insert. A Contact draft stands in for one Turnstile check: it is used by one conditional update (`usedAt`
  null, not expired) and never reused.
- An account's purge runs in Better Auth's `user.deleteUser.beforeDelete`, never in `databaseHooks.user.delete`: the
  anonymous plugin deletes a linked anonymous user through the internal adapter after its jobs moved to the account,
  and their videos still sit under the anonymous user's prefix.
- A job's upload is at `file.path`, which after linking can be under another user's prefix. Delete by that path; never
  derive it from `userId`.
- Clients only ever receive the public job shape from `jobs/job.mapper.ts`; owner, storage path, execution and
  accounting fields stay server-side.
- The request, response and error shapes come from `adlens-shared`. Change the contract there first, publish it, then
  bump the exact pin here. Never commit a `file:` dependency.
- All configuration goes through the Zod schema in `src/config/env.ts`. Tests set `NODE_ENV=test`, which stops env
  files from loading, so tests can never reach a real database or bucket.
- Production secrets go in the `API_SECRETS` Secret Manager bundle, via `infra/setup.sh` (put the key in the git-ignored
  `.env.production`, never `.env.local`, and run the script) — never as their own individual secret, and never as a plain env var in a deploy command.
- The committed `.env` ships in the production image: only public values meant for every environment go there (it is
  where `QUOTA_LIMIT` is set). Local-only values go in `.env.local`, secrets in the bundle above.
- `ANALYZE_MAX_RETRIES` must equal the Cloud Run Job's `--max-retries` in `infra/setup.sh`.
- Never delete a user's upload on a transient storage or network error; only a definite problem with the file
  deletes it.
- A job with a `sampleId` points at a shared sample video under `samples/`: it skips upload verification, and nothing
  that cleans up jobs or accounts may ever delete that object.

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
- A Better Auth index that fails to build only logs `could not create the Better Auth index <name>` at startup. After
  a deploy that adds one, check the logs, or `getIndexes()` in Atlas.
- Before upgrading Better Auth, diff its table-level `indexes` against `AUTH_INDEXES`: an index on the same key with
  a different name or options raises `IndexOptionsConflict` in the adapter's `ensureModelIndexes`, which runs before
  every write, so every write would fail.
