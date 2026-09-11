# AdLens backend — key decisions

Records the non-obvious architecture choices for the off-Firebase stack. Companion: the migration plan in the design-docs drive folder.

- **MongoDB Atlas + Mongoose** over Postgres/Prisma. The job document (nested `media` + `analysis`) is document-shaped, and MongoDB is the portfolio's demand gap. Atlas M0 (europe-west1) is the free tier; Change Streams (needed for realtime) require the replica set it provides.
- **NestJS on Cloud Run** (CommonJS). Guards/pipes/DI make ownership + quota explicit. One image, two services: API (`node dist/main`) and worker (`node dist/worker`, HTTP health only, CPU always-on, 1 min instance).
- **Better Auth** (email/password, Mongo adapter, bearer plugin). Loads fine under Node 22 CommonJS. Mounted before the body parser; cross-origin uses a bearer token (no third-party cookies). Social login can be added later behind the same guard.
- **BullMQ on Redis** for the analysis queue; the runner ports the pre-existing multimodal pipeline unchanged.
- **Socket.IO + MongoDB Change Streams** for realtime job updates, replacing Firestore `onSnapshot`. One change-stream watcher per API instance; the Redis socket adapter is the scaling step, not needed yet.
- **GCS V4 signed uploads** to a EU bucket (`adlens-ca57f-uploads`, europe-west1), co-located with compute. The Cloud Run runtime SA signs via `iam.serviceAccounts.signBlob` (granted on itself); local signing needs a SA key, so signing is exercised on deploy.
- **Gemini on Vertex AI** via ADC (no key). `gemini-3.6-flash` on the multi-region `global` endpoint (3.x isn't on `us-central1`).
- **No Pulumi.** Infra is small and set-once, and IaC is already demonstrated twice in the portfolio (CDK, Terraform). Provisioning is a committed `infra/setup.sh` (`gcloud`) instead; Pulumi stays an optional later upgrade.
- **`adlens-shared`** is the schema-first contract (Zod source of truth → generated types), dual-format (ESM + CJS) so the ESM web and CJS API both consume it; published to npm for deploys.
