#!/usr/bin/env bash
# AdLens infrastructure setup. Idempotent-ish gcloud script — safe to re-run.
# A handful of set-once resources, so a committed gcloud script instead of Terraform/Pulumi (see the README's
# design decisions).
#
# The analysis runs as an on-demand Cloud Run Job (adlens-analyze) launched by the API — there is no
# always-on worker service and no Redis.
#
# Day-to-day deploys don't use this script: every push to init-setup that passes CI is built into one image and rolled
# out to the job and the API by .github/workflows/ci.yml. This script creates everything that workflow relies on and
# owns the runtime config (env vars, secrets, limits); it also deploys the current checkout the same way CI does.
#
# Prereqs: gcloud authenticated (`gcloud auth login`). To create or rotate a secret, export it first:
#   export MONGODB_URI='mongodb+srv://…/adlens?retryWrites=true&w=majority'
#   export BETTER_AUTH_SECRET='<a long random string>'
#   export CONTACT_EMAIL='<the inbox that receives Contact form messages>'
#   export GOOGLE_CLIENT_SECRET='<the Google OAuth client secret>'
#   export GITHUB_CLIENT_SECRET='<the GitHub OAuth app client secret>'
#   export TURNSTILE_SECRET_KEY='<the Turnstile widget's secret key, Cloudflare dashboard>'
# Unset secrets are left as they are. RESEND_API_KEY must already exist in Secret Manager (a sending-only Resend key
# for mail.useadlens.com).
set -euo pipefail

PROJECT=adlens-ca57f
PROJECT_NUMBER=629217115736
REGION=europe-west1
BUCKET=adlens-ca57f-uploads
RUNTIME_SA="adlens-run@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA="adlens-deploy@${PROJECT}.iam.gserviceaccount.com"
IMAGE_REPO=adlens
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${IMAGE_REPO}/api"
API_SVC=adlens-api
ANALYZE_JOB=adlens-analyze
WEB_ORIGIN=https://www.useadlens.com
API_URL=https://api.useadlens.com
COOKIE_DOMAIN=useadlens.com
# GitHub numeric ids (not names) so a renamed or re-created repo can't inherit deploy access.
GITHUB_OWNER_ID=70646891
GITHUB_REPO_ID=1306464238
DEPLOY_BRANCH=init-setup
# OAuth client IDs are public (they appear in every sign-in redirect); their secrets are in Secret Manager.
GOOGLE_CLIENT_ID=629217115736-aop8hg7sorfps05t4gp7fv83gt0h937s.apps.googleusercontent.com
GITHUB_CLIENT_ID=Ov23ct4gfbO6JyiOGopx

gcloud config set project "$PROJECT"

echo "== enable APIs =="
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    aiplatform.googleapis.com secretmanager.googleapis.com storage.googleapis.com iamcredentials.googleapis.com \
    sts.googleapis.com

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
for name in MONGODB_URI BETTER_AUTH_SECRET CONTACT_EMAIL GOOGLE_CLIENT_SECRET GITHUB_CLIENT_SECRET TURNSTILE_SECRET_KEY; do
    if [ -n "${!name:-}" ]; then
        printf '%s' "${!name}" | gcloud secrets create "$name" --data-file=- 2>/dev/null || \
            printf '%s' "${!name}" | gcloud secrets versions add "$name" --data-file=-
    fi
    gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
done
gcloud secrets add-iam-policy-binding RESEND_API_KEY --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor"

echo "== image repository =="
gcloud artifacts repositories describe "$IMAGE_REPO" --location="$REGION" >/dev/null 2>&1 || \
    gcloud artifacts repositories create "$IMAGE_REPO" --repository-format=docker --location="$REGION" \
        --description="AdLens container images"

echo "== GitHub Actions deployer (Workload Identity Federation, no service account key) =="
gcloud iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 || \
    gcloud iam service-accounts create adlens-deploy --display-name="AdLens GitHub Actions deployer"
# Push images, update the job and the service, and deploy revisions that run as the runtime SA.
gcloud artifacts repositories add-iam-policy-binding "$IMAGE_REPO" --location="$REGION" \
    --member="serviceAccount:$DEPLOY_SA" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role="roles/run.developer" \
    --condition=None
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$DEPLOY_SA" \
    --role="roles/iam.serviceAccountUser"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 || \
    gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
# Only this repository's pushes to the deploy branch can exchange their GitHub token.
gcloud iam workload-identity-pools providers describe adlens-api --location=global --workload-identity-pool=github \
    >/dev/null 2>&1 || \
    gcloud iam workload-identity-pools providers create-oidc adlens-api --location=global \
        --workload-identity-pool=github --display-name="adlens-api deploys" \
        --issuer-uri="https://token.actions.githubusercontent.com" \
        --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
        --attribute-condition="assertion.repository_owner_id == '$GITHUB_OWNER_ID' && assertion.repository_id == '$GITHUB_REPO_ID' && assertion.ref == 'refs/heads/$DEPLOY_BRANCH'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$GITHUB_REPO_ID"

echo "== build one image for the job and the API =="
TAG="manual-$(git rev-parse --short HEAD)"
gcloud builds submit --tag "$IMAGE:$TAG" .
IMAGE_REF="$IMAGE@$(gcloud artifacts docker images describe "$IMAGE:$TAG" --format='value(image_summary.digest)')"

echo "== deploy analysis worker job (on-demand; runs dist/worker to completion, retried twice) =="
gcloud run jobs deploy "$ANALYZE_JOB" --image="$IMAGE_REF" --region="$REGION" --service-account="$RUNTIME_SA" \
    --command="node" --args="dist/worker" --tasks=1 --max-retries=2 --task-timeout=15m \
    --cpu=2 --memory=2Gi \
    --set-secrets="MONGODB_URI=MONGODB_URI:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,GEMINI_LOCATION=global,ANALYZE_MAX_RETRIES=2"
# The API executes this job as the runtime SA. run.developer on the job includes run.jobs.run; narrow
# to a custom role with only run.jobs.run + run.executions.get if you prefer (verify with a dry run).
gcloud run jobs add-iam-policy-binding "$ANALYZE_JOB" --region="$REGION" \
    --member="serviceAccount:$RUNTIME_SA" --role="roles/run.developer"

echo "== deploy API (served at $API_URL through a Cloud Run domain mapping) =="
gcloud run deploy "$API_SVC" --image="$IMAGE_REF" --region="$REGION" --service-account="$RUNTIME_SA" \
    --allow-unauthenticated \
    --set-secrets="MONGODB_URI=MONGODB_URI:latest,BETTER_AUTH_SECRET=BETTER_AUTH_SECRET:latest,RESEND_API_KEY=RESEND_API_KEY:latest,CONTACT_EMAIL=CONTACT_EMAIL:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GITHUB_CLIENT_SECRET=GITHUB_CLIENT_SECRET:latest,TURNSTILE_SECRET_KEY=TURNSTILE_SECRET_KEY:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,WEB_ORIGIN=$WEB_ORIGIN,BETTER_AUTH_URL=$API_URL,COOKIE_DOMAIN=$COOKIE_DOMAIN,GEMINI_LOCATION=global,GCP_REGION=$REGION,ANALYZE_JOB_NAME=$ANALYZE_JOB,GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID,GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID"
echo "Done. The web app's NEXT_PUBLIC_API_BASE_URL is $API_URL"
