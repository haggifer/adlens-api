#!/usr/bin/env bash
# AdLens infrastructure setup (Phase 4). Idempotent-ish gcloud script — safe to re-run.
# Pulumi was deliberately skipped: infra is small/set-once and IaC is already shown twice in the
# portfolio (CDK, Terraform). See DECISIONS.md.
#
# The analysis runs as an on-demand Cloud Run Job (adlens-analyze) launched by the API — there is no
# always-on worker service and no Redis.
#
# Prereqs: gcloud authenticated (`gcloud auth login`), and these set in your shell first:
#   export MONGODB_URI='mongodb+srv://…/adlens?retryWrites=true&w=majority'
#   export BETTER_AUTH_SECRET='<a long random string>'
#   export WEB_ORIGIN='https://www.useadlens.com'
set -euo pipefail

PROJECT=adlens-ca57f
REGION=europe-west1
BUCKET=adlens-ca57f-uploads
RUNTIME_SA="adlens-run@${PROJECT}.iam.gserviceaccount.com"
API_SVC=adlens-api
ANALYZE_JOB=adlens-analyze

gcloud config set project "$PROJECT"

echo "== enable APIs =="
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    aiplatform.googleapis.com secretmanager.googleapis.com storage.googleapis.com

echo "== uploads bucket + CORS =="
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
    gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets update "gs://$BUCKET" --cors-file="$(dirname "$0")/cors.json"

echo "== runtime service account =="
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 || \
    gcloud iam service-accounts create adlens-run --display-name="AdLens Cloud Run runtime"
# Vertex (Gemini), read/write the uploads bucket, and sign V4 URLs (signBlob on itself).
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" --role="roles/aiplatform.user"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNTIME_SA" --role="roles/storage.objectAdmin"
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$RUNTIME_SA" --role="roles/iam.serviceAccountTokenCreator"
# The API launches the analysis job as itself, so it must be able to act as the runtime SA.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$RUNTIME_SA" --role="roles/iam.serviceAccountUser"

echo "== secrets =="
for name in MONGODB_URI BETTER_AUTH_SECRET; do
    printf '%s' "${!name}" | gcloud secrets create "$name" --data-file=- 2>/dev/null || \
        printf '%s' "${!name}" | gcloud secrets versions add "$name" --data-file=-
    gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
done

echo "== deploy analysis worker job (on-demand; runs dist/worker to completion, retried twice) =="
gcloud run jobs deploy "$ANALYZE_JOB" --source . --region="$REGION" --service-account="$RUNTIME_SA" \
    --command="node" --args="dist/worker" --tasks=1 --max-retries=2 --task-timeout=15m \
    --cpu=2 --memory=2Gi \
    --set-secrets="MONGODB_URI=MONGODB_URI:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,GEMINI_LOCATION=global,ANALYZE_MAX_RETRIES=2"
# The API executes this job as the runtime SA. run.developer on the job includes run.jobs.run; narrow
# to a custom role with only run.jobs.run + run.executions.get if you prefer (verify with a dry run).
gcloud run jobs add-iam-policy-binding "$ANALYZE_JOB" --region="$REGION" \
    --member="serviceAccount:$RUNTIME_SA" --role="roles/run.developer"

echo "== deploy API =="
gcloud run deploy "$API_SVC" --source . --region="$REGION" --service-account="$RUNTIME_SA" \
    --allow-unauthenticated \
    --set-secrets="MONGODB_URI=MONGODB_URI:latest,BETTER_AUTH_SECRET=BETTER_AUTH_SECRET:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,WEB_ORIGIN=$WEB_ORIGIN,GEMINI_LOCATION=global,GCP_REGION=$REGION,ANALYZE_JOB_NAME=$ANALYZE_JOB"
API_URL=$(gcloud run services describe "$API_SVC" --region="$REGION" --format="value(status.url)")
# BETTER_AUTH_URL must be the API's own public URL.
gcloud run services update "$API_SVC" --region="$REGION" --update-env-vars="BETTER_AUTH_URL=$API_URL"
echo "API deployed at $API_URL"

echo "Done. Set the web's NEXT_PUBLIC_API_BASE_URL to: $API_URL"
