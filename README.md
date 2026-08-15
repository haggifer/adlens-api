# adlens-api

Backend for **AdLens** — a single [Firebase Functions v2](https://firebase.google.com/docs/functions) codebase (TypeScript, ESM) exposing:

- an **HTTP API** (Express) for job CRUD / auth / storage, and
- **Cloud Tasks workers** that run the heavy Gemini AI work asynchronously.

One repo, two deploy units, shared `src/lib` + `src/services`.

## Architecture

| Function          | Kind                             | Config       | Responsibility                                          |
| ----------------- | -------------------------------- | ------------ | ------------------------------------------------------- |
| `api`             | HTTPS (`onRequest`, Express)     | 256MiB / 60s | `/health`, `/jobs/*`, `/ai/*` — fast request→response   |
| `transcribeVideo` | Cloud Tasks (`onTaskDispatched`) | 1GiB / 540s  | Gemini video transcription; writes results to Firestore |

### The async flow (queue pattern)

1. Client uploads the video **directly to Cloud Storage** (Firebase client SDK) under `users/{uid}/jobs/{jobId}/…`.
2. `POST /ai/analyze-video { jobId }` → the handler marks the job `queued`, **enqueues a Cloud Task** carrying only `{ uid, jobId }` (a claim check), and returns **202** immediately.
3. Cloud Tasks delivers the task to `transcribeVideo`, which re-fetches the job, runs Gemini over the `gs://` URI, and writes `transcript` + `status: 'transcribed'` back to Firestore.
4. The client observes the job doc via Firestore `onSnapshot` and renders when the status flips. No polling, no long-held HTTP connections.

Payloads are identifiers only — Firestore/Storage stay the single source of truth.

## Data model

One unified doc per job at `users/{uid}/jobs/{jobId}`: file metadata + status + results together. Every read/write is scoped to the verified uid. The `Job`/`JobStatus`/`JobFile` shapes are shared with the frontend via the [`adlens-types`](https://github.com/haggifer/adlens-types) package (a type-only dev dependency).

## Auth

Every `/jobs/*` and `/ai/*` request needs `Authorization: Bearer <Firebase ID token>`. The [`requireAuth`](src/lib/auth.ts) middleware verifies it and sets `req.uid`. **uid always comes from the verified token, never the request body.**

## Gemini

[`src/lib/gemini.ts`](src/lib/gemini.ts) uses **Vertex AI** (ADC auth, reads `gs://` URIs directly — no API key to manage). A switchable `GEMINI_MODELS` registry lets tasks pick a model per call.

## Project layout

```
src/
  index.ts              exports the `api` + `transcribeVideo` functions
  app.ts                Express app assembly
  lib/                  firebase, auth, gemini, errors
  services/             job-service, gemini-service   (reused domain logic)
  utils/                paths, validation             (pure helpers)
  routes/               health, jobs/, ai/            (thin HTTP handlers)
  tasks/                transcribe-video              (Cloud Tasks workers)
  types/                express Request augmentation (shared domain types live in adlens-types)
```

Imports use the `@/*` alias (→ `src/*`), resolved for runtime by `tsc-alias` during the build (`tsc && tsc-alias`).

## Local development

```bash
npm install
npm run serve   # builds, then starts the Firebase Emulator Suite (functions/auth/firestore/storage)
```

For Vertex/Gemini calls against the real API from the emulator, provide ADC (`gcloud auth application-default login`). Put emulator-only secrets in `.secret.local` (gitignored).

## Deploy

```bash
npm run deploy   # firebase deploy --only functions (runs the build via predeploy)
```

The frontend (separate `adlens` repo, Firebase App Hosting) calls the function URLs — wire clean same-origin paths there via App Hosting rewrites (`/jobs/**`, `/ai/**` → the `api` function).

## Scripts

| Command          | Description       |
| ---------------- | ----------------- |
| `npm run build`  | `tsc` → `dist/`   |
| `npm run watch`  | `tsc --watch`     |
| `npm run serve`  | build + emulators |
| `npm run deploy` | deploy functions  |
| `npm run lint`   | ESLint            |
| `npm run format` | Prettier          |
