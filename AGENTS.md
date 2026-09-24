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
npm run rules:publish    # publish src/rules/rules.json as a new immutable ruleset version
npm run samples:publish -- <manifest.json> [--dry-run]   # publish or update a sample ad
```

## Rules that must not break

- A job is created `pending`; after that, `JobLifecycle` is the only code that changes its status, and every transition
  is a conditional update on the expected current status. Don't write `status` anywhere else.
- A quota charge is refunded at most once, by whoever clears `chargedWindowStart` in the write that ends the run. Keep
  the charge, the final status and that field in one update.
- Clients only ever receive the public job shape from `jobs/job.mapper.ts`; owner, storage path, execution and
  accounting fields stay server-side.
- The request, response and error shapes come from `adlens-shared`. Change the contract there first, publish it, then
  bump the exact pin here. Never commit a `file:` dependency (`npm run check:deps` fails on it).
- All configuration goes through the Zod schema in `src/config/env.ts`. Tests set `NODE_ENV=test`, which stops env
  files from loading, so tests can never reach a real database or bucket.
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
- Jest can't load Better Auth's ESM build, so the e2e suite stubs it; real auth behaviour is covered by `test:auth`.
- Better Auth needs MongoDB transactions, so tests use an in-memory replica set.
- With `ANALYZE_LOCAL=1` the API spawns `node dist/worker`, so `dist/` must be built.
