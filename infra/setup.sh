#!/usr/bin/env bash
# AdLens infrastructure setup (Phase 4). Idempotent-ish gcloud script — safe to re-run.
# Pulumi was deliberately skipped: infra is small/set-once and IaC is already shown twice in the
# portfolio (CDK, Terraform). See DECISIONS.md.
#
# Prereqs: gcloud authenticated (`gcloud auth login`), and these set in your shell first:
#   export MONGODB_URI='mongodb+srv://…/adlens?retryWrites=true&w=majority'
#   export BETTER_AUTH_SECRET='<a long random string>'
#   export REDIS_URL='rediss://…'                 # from Redis Cloud
#   export WEB_ORIGIN='https://<your-vercel-app>.vercel.app'   # set after the web is deployed
set -euo pipefail

PROJECT=adlens-ca57f
REGION=europe-west1
BUCKET=adlens-ca57f-uploads
RUNTIME_SA="adlens-run@${PROJECT}.iam.gserviceaccount.com"
API_SVC=adlens-api
WORKER_SVC=adlens-worker

gcloud config set project "$PROJECT"

echo "== enable APIs =="
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    aiplatform.googleapis.com secretmanager.googleapis.com storage.googleapis.com

echo "== uploads bucket (created already; ensure CORS) =="
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
    gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access

echo "== runtime service account =="
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 || \
    gcloud iam service-accounts create adlens-run --display-name="AdLens Cloud Run runtime"
# Vertex (Gemini), read/write the uploads bucket, and sign V4 URLs (signBlob on itself).
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" --role="roles/aiplatform.user"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNTIME_SA" --role="roles/storage.objectAdmin"
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$RUNTIME_SA" --role="roles/iam.serviceAccountTokenCreator"

echo "== secrets =="
for name in MONGODB_URI BETTER_AUTH_SECRET REDIS_URL; do
    printf '%s' "${!name}" | gcloud secrets create "$name" --data-file=- 2>/dev/null || \
        printf '%s' "${!name}" | gcloud secrets versions add "$name" --data-file=-
    gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
done

echo "== deploy API =="
gcloud run deploy "$API_SVC" --source . --region="$REGION" --service-account="$RUNTIME_SA" \
    --allow-unauthenticated \
    --set-secrets="MONGODB_URI=MONGODB_URI:latest,BETTER_AUTH_SECRET=BETTER_AUTH_SECRET:latest,REDIS_URL=REDIS_URL:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,WEB_ORIGIN=$WEB_ORIGIN,GEMINI_LOCATION=global"
API_URL=$(gcloud run services describe "$API_SVC" --region="$REGION" --format="value(status.url)")
# BETTER_AUTH_URL must be the API's own public URL.
gcloud run services update "$API_SVC" --region="$REGION" --update-env-vars="BETTER_AUTH_URL=$API_URL"
echo "API deployed at $API_URL"

echo "== deploy worker (HTTP health only; CPU always-on, 1 min instance) =="
gcloud run deploy "$WORKER_SVC" --source . --region="$REGION" --service-account="$RUNTIME_SA" \
    --no-allow-unauthenticated --no-cpu-throttling --min-instances=1 \
    --command="node" --args="dist/worker" \
    --set-secrets="MONGODB_URI=MONGODB_URI:latest,REDIS_URL=REDIS_URL:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,GEMINI_LOCATION=global"

echo "Done. Set the web's NEXT_PUBLIC_API_BASE_URL to: $API_URL"
