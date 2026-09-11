# adlens-api

Backend for **AdLens** — a single [Firebase Functions v2](https://firebase.google.com/docs/functions) codebase (TypeScript, ESM):

- an **HTTP API** (Express) — the only writer of Firestore, and
- a **Cloud Tasks worker** that runs the multimodal ad-policy analysis asynchronously.

## Access-control model

**The client is never the boundary.** Enforcement lives in two tamper-proof layers: **Security Rules** (Google evaluates them on every read/write) and this **API** (verifies the Firebase ID token with the Admin SDK).

- **Ownership by path** — all user data lives under `/users/{uid}/…`; `request.auth.uid == uid` is the entire ownership boundary (no `ownerId` field to forge).
- **Reads go direct** — the client reads its own subtree via the Firestore SDK (real-time, rules-gated). There are **no read endpoints**.
- **Writes go through the API** — clients write **nothing** to Firestore (`write: if false`). Every mutation goes through an endpoint that verifies the token, validates a **strict Zod allowlist**, and writes via the Admin SDK (which bypasses rules). This is what prevents mass assignment.
- **One direct client write** — the video binary, uploaded straight to Storage under `users/{uid}/{timestamp}/…`, gated by [`storage.rules`](storage.rules) (owner + `< 200 MB` + `video/*`). The server then **verifies the actual bytes** before any Gemini spend.

Rules: [`firestore.rules`](firestore.rules), [`storage.rules`](storage.rules). Deploy them with `firebase deploy --only firestore:rules,storage`.

## Functions

| Function       | Kind                             | Config      | Responsibility                                                          |
| -------------- | -------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `api`          | HTTPS (`onRequest`, Express)     | 1GiB / 120s | `/health`, `/v1/*` — includes synchronous content verification         |
| `analyzeVideo` | Cloud Tasks (`onTaskDispatched`) | 1GiB / 540s | Multimodal analysis: transcript + rule findings; writes back to Firestore |

## API surface

Every `/v1/*` request needs `Authorization: Bearer <Firebase ID token>`; [`requireAuth`](src/infra/auth.ts) verifies it and sets `req.uid` (uid comes from the token, never the body).

| Method & path                  | Purpose                                           | Returns           |
| ------------------------------ | ------------------------------------------------- | ----------------- |
| `POST /v1/jobs`                | Create a `pending` job, reserve the upload path   | `201 { job }`     |
| `POST /v1/jobs/:jobId/analyze` | Verify upload → consume quota → enqueue analysis  | `202 { job }`     |
| `PATCH /v1/me/profile`         | Update allowlisted profile fields                 | `200 { profile }` |

Job reads (`/users/{uid}/jobs/{jobId}`) and quota (`/users/{uid}/private/quota`) are **not** endpoints — the client subscribes to them directly.

### The flow

1. `POST /v1/jobs { settings, file }` → server creates the job and returns the reserved `file.bucket`/`file.path` (`users/{uid}/{timestamp}/{filename}`).
2. Client uploads the video to that path (Storage SDK, gated by rules).
3. `POST /v1/jobs/:jobId/analyze` → **verify bytes** ([`services/verify.ts`](src/services/verify.ts): `file-type` magic bytes + `ffprobe` for duration/dimensions/audio, duration cap). On failure: delete the object, mark `error`, return `422`, **no quota spent**. On success: **consume quota** in a transaction ([`services/quota.ts`](src/services/quota.ts), 3/week; `429` if spent), store the media facts, mark `queued`, enqueue `analyzeVideo`, return `202`.
4. The worker ([`tasks/analyze-video.ts`](src/tasks/analyze-video.ts)) selects the relevant rules, checks the deterministic (metadata) ones in code, runs **one multimodal Gemini pass** over the video for the content rules (transcript + per-rule findings), builds the advisory checklist for `out_of_creative` rules, writes a `result.json` into the upload folder, and sets `status: 'analyzed'` with the full `analysis` on the job doc.
5. The client watches the job doc via `onSnapshot` and renders the findings.

## Ad-policy rules

The ruleset is **static and bundled** ([`src/rules/rules.json`](src/rules/rules.json)) — no scraper, no database. Each rule carries a `modality` that drives routing ([`src/rules/index.ts`](src/rules/index.ts)):

- `metadata` → checked **in code** against the extracted media facts (duration, dimensions, filesize).
- `text` / `visual` / `audiovisual` → projected to `{ id, check, severity, modality }` and evaluated by the **multimodal model** over the video. `quote` + resolved `ref` are attached back by id for citation (they never cost prompt tokens).
- `out_of_creative` (targeting / local-law / verification) → surfaced as an **advisory checklist**, never auto-judged.

Rules are validated with a Zod schema ([`src/rules/schema.ts`](src/rules/schema.ts)) at load. Backreferences use a `{{SOURCE_KEY}}` URL dictionary resolved via `resolveRef`. To regenerate, follow `rule_distillation_guide.md`, drop the new file in as `src/rules/rules.json`, and bump its `meta.version`.

## Data model

- `/users/{uid}` — profile `{ displayName?, photoURL?, createdAt, updatedAt }` (client-readable, server-written)
- `/users/{uid}/private/quota` — `{ used, limit, windowStart }` (client-readable, server-written; created lazily on first analyze)
- `/users/{uid}/jobs/{jobId}` — `Job` (settings + status + `media` + `analysis`)
- Storage: `users/{uid}/{timestamp}/{filename}` — the uploaded video, plus `result.json` (server-written analysis artifact)

Shared shapes (`Job`, `AnalysisSettings`, `Analysis`, `Finding`, …) live in the [`adlens-shared`](https://github.com/haggifer/adlens-shared) package.

> **Deploy note:** the routes import **runtime** Zod schemas from `adlens-shared`, but it is currently listed under `devDependencies`. A production install omits it, so before deploying either move it to `dependencies` (and make the repo reachable by Cloud Build), bundle the function, or keep local schemas. Local dev/emulator is unaffected.

## Gemini

[`src/infra/gemini.ts`](src/infra/gemini.ts) uses **Vertex AI** (`vertexai: true`), authenticated via **ADC** — no API key to manage. The worker passes the video's `gs://` URI straight to `generateContent` (`createPartFromUri`), so Vertex reads the object directly from Storage. The model is `gemini-3.6-flash` by default (override with `GEMINI_MODEL`). The Gemini 3.x models are served from the multi-region **`global`** endpoint (not `us-central1`), so the client location defaults to `global` (override with `GEMINI_LOCATION`).

> Vertex reads a real GCS bucket, **not the Storage emulator**. Local end-to-end analysis therefore needs the real `us-central1` bucket plus ADC (`gcloud auth application-default login`); everything else (auth / Firestore / job creation / verification / quota / enqueue) runs fully emulated.

## Environment

Non-secret config lives in [`.env`](.env) (loaded by the Firebase CLI in the emulator and on deploy):

| Variable          | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `STORAGE_BUCKET`  | The bucket both SDKs use — must match the frontend's storage bucket.    |
| `GEMINI_MODEL`    | Optional Gemini model override.                                         |
| `ALLOWED_ORIGINS` | Optional extra CORS origins (comma-separated); localhost always allowed. |

Gemini uses Vertex AI via ADC, so there is **no** API key in `.env` or Secret Manager. Provide credentials with `gcloud auth application-default login` (the account needs the Vertex AI User role on the project).

## Project layout

```
src/
  index.ts        exports the api + analyzeVideo functions
  app.ts          Express app assembly (helmet, cors, routers)
  infra/          firebase, auth, gemini, errors
  services/       jobs, quota, profile, verify, analyze (multimodal Gemini)
  rules/          rules.json + schema (validator) + selection/projection/metadata evaluation
  utils/          paths (pure helpers)
  routes/         health, v1/ (jobs, me)
  tasks/          analyze-video (Cloud Tasks worker)
  types/          express Request augmentation, ffprobe-static ambient types
```

Imports use the `@/*` alias (→ `src/*`), resolved for runtime by `tsc-alias` during the build. `rules.json` is copied into `dist/` by `scripts/copy-assets.mjs` (tsc does not emit JSON).

## Local development

Recommended: **functions-emulator-only**. The API runs locally (hot-reload, no deploy) while auth, Firestore, Storage, and Vertex are the real project — so Vertex can read the uploaded `gs://` video (it cannot read the Storage emulator). Everything reaches the real backend through ADC.

```bash
gcloud auth application-default login          # once; account needs the Vertex AI User role
gcloud config set project adlens-ca57f
npm install
npm run serve:functions                        # build + Functions emulator only (real Firestore/Storage/Vertex)
```

Then run the frontend (`cd ../adlens && npm run dev`); its `.env.local` already points `NEXT_PUBLIC_API_BASE_URL` at `http://127.0.0.1:5001/adlens-ca57f/us-central1/api`, and it uses the real Firebase project for auth/Firestore/Storage.

The full Emulator Suite (`npm run serve`) is also available, but Vertex cannot read the Storage emulator, so the analysis step won't complete under it — use it only for the non-AI path.

## Deploy

```bash
firebase deploy --only firestore:rules,storage   # rules
npm run deploy                                    # functions (build runs via predeploy)
```

`ffprobe-static` fetches its platform binary during the Cloud Build install, so no binary is committed.

## Scripts

| Command          | Description                                       |
| ---------------- | ------------------------------------------------- |
| `npm run build`  | `tsc && tsc-alias` + copy assets → `dist/`         |
| `npm run serve`  | build + emulators                                 |
| `npm run deploy` | deploy functions                                  |
| `npm run lint`   | ESLint                                            |
| `npm run format` | Prettier                                          |
