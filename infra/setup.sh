#!/usr/bin/env bash
# AdLens infrastructure setup. Idempotent-ish gcloud script — safe to re-run.
# A handful of set-once resources, so a committed gcloud script instead of Terraform/Pulumi (see the README's
# design decisions).
#
# The analysis runs as an on-demand Cloud Run Job (adlens-analyze) launched by the API — there is no
# always-on worker service and no Redis. A second job (adlens-cleanup), started daily by Cloud Scheduler, deletes
# anonymous users unused for a week and the videos of jobs not analyzed within 6 hours, and retries owed refunds. A
# third (adlens-db) runs after every deploy: the pending data migrations, every declared index, then the collections'
# validators.
#
# Day-to-day deploys don't use this script: every push to init-setup that passes CI is built into one image, rolled
# out to the jobs and the API, and followed by a run of adlens-db, by .github/workflows/ci.yml. This script creates everything that workflow relies on and
# owns the runtime config (env vars, secrets, limits); it also deploys the current checkout the same way CI does.
#
# Prereqs: gcloud authenticated (`gcloud auth login`). To create or rotate a secret, put any subset of the bundle keys
# in .env.production at the repo root (git-, gcloud- and docker-ignored like every .env.* file) and re-run: the script
# merges them into the API_SECRETS bundle (one Secret Manager secret holding all of the API's secrets as JSON; see the
# README's design decisions), leaving keys the file doesn't set as they were. One KEY=value per line, taken literally
# (no inline comments or escapes; surrounding quotes are optional and stripped):
#   MONGODB_URI=mongodb+srv://…/adlens?retryWrites=true&w=majority
#   BETTER_AUTH_SECRET=<a long random string>
#   RESEND_API_KEY=<a Resend sending key for mail.useadlens.com>
#   CONTACT_EMAIL=<the inbox that receives Contact form messages>
#   GOOGLE_CLIENT_SECRET=<the Google OAuth client secret>
#   GITHUB_CLIENT_SECRET=<the GitHub OAuth app client secret>
#   TURNSTILE_SECRET_KEY=<the Turnstile widget's secret key, Cloudflare dashboard>
#   ABLY_API_KEY=<an Ably API key whose capability is publish and subscribe on user:* only, Ably dashboard>
# It is not .env.local: that file holds local values (e.g. Turnstile's always-pass test key) that must never reach
# production. The first run after upgrading from one-secret-per-key needs no file for the keys the old individual
# secrets of the same names already held: it folds those in.
set -euo pipefail

# The RESOLVED_VALUE/RESOLVED_SOURCE associative arrays below need bash 4+. macOS ships bash 3.2 (Apple stopped
# bundling GPLv3 bash), so this fails fast there with a clear message instead of an obscure "declare: -A: invalid
# option" later: install a newer bash first (macOS: brew install bash).
((BASH_VERSINFO[0] >= 4)) || { echo "infra/setup.sh needs bash 4 or later (macOS: brew install bash)." >&2; exit 1; }

# Git Bash (MSYS) rewrites an argument that looks like a POSIX path before it reaches a native program — which
# mangles SECRETS_FILE's value and a secret's mount path inside --set-env-vars / --set-secrets. Exclude only those
# two flags, never MSYS_NO_PATHCONV globally: that also stops the gcloud launcher script from finding itself.
# Harmless where MSYS2_ARG_CONV_EXCL doesn't exist (Linux, macOS).
export MSYS2_ARG_CONV_EXCL="--set-env-vars=;--set-secrets="

PROJECT=adlens-ca57f
PROJECT_NUMBER=629217115736
REGION=europe-west1
BUCKET=adlens-ca57f-uploads
# Demo and sample videos only, readable by anyone; user uploads never go here.
PUBLIC_MEDIA_BUCKET=adlens-ca57f-public-media
RUNTIME_SA="adlens-run@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA="adlens-deploy@${PROJECT}.iam.gserviceaccount.com"
IMAGE_REPO=adlens
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${IMAGE_REPO}/api"
API_SVC=adlens-api
ANALYZE_JOB=adlens-analyze
CLEANUP_JOB=adlens-cleanup
DB_JOB=adlens-db
# Daily, at a quiet hour for Europe. Anonymous data is kept for a week, so a missed day only delays a deletion.
CLEANUP_SCHEDULE="0 3 * * *"
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
# One Secret Manager secret holding every API secret as a JSON object, mounted as a file (see README). The free
# tier counts active secret *versions*, not secrets, so one bundle uses one version however many keys it holds.
SECRETS_BUNDLE=API_SECRETS
SECRETS_PATH=/secrets/api.json
BUNDLE_KEYS="MONGODB_URI BETTER_AUTH_SECRET RESEND_API_KEY CONTACT_EMAIL GOOGLE_CLIENT_SECRET GITHUB_CLIENT_SECRET TURNSTILE_SECRET_KEY ABLY_API_KEY"
# RESEND_API_KEY and CONTACT_EMAIL are required because MailModule and ContactService assert them at startup; the API
# won't boot without them.
REQUIRED_KEYS="MONGODB_URI BETTER_AUTH_SECRET RESEND_API_KEY CONTACT_EMAIL"
ENV_FILE="$(dirname "$0")/../.env.production"

gcloud config set project "$PROJECT"

echo "== enable APIs =="
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    aiplatform.googleapis.com secretmanager.googleapis.com storage.googleapis.com iamcredentials.googleapis.com \
    sts.googleapis.com cloudscheduler.googleapis.com

echo "== uploads bucket + CORS =="
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
    gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets update "gs://$BUCKET" --cors-file="$(dirname "$0")/cors.json"
# Images attached to Contact form messages are only needed until the message is read.
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file="$(dirname "$0")/lifecycle.json"

echo "== public media bucket (demo and sample videos) =="
# A separate bucket because GCS refuses a public grant limited to a prefix ("Conditions are not allowed on public
# resources"), and a public grant on the uploads bucket would expose every user's video.
gcloud storage buckets describe "gs://$PUBLIC_MEDIA_BUCKET" >/dev/null 2>&1 || \
    gcloud storage buckets create "gs://$PUBLIC_MEDIA_BUCKET" --location="$REGION" --uniform-bucket-level-access
# Read by address only: objectViewer would also let anyone list the bucket, unpublished demos and samples included.
gcloud storage buckets add-iam-policy-binding "gs://$PUBLIC_MEDIA_BUCKET" --member=allUsers --role="roles/storage.legacyObjectReader"
# Removes the listable grant this bucket had before 2026-10-14, only when present (removing an absent one fails).
# `gcloud storage buckets get-iam-policy` takes no --filter, so the grant is matched in its flattened rows; `tr -d '\r'`
# strips the CRLF Git Bash's gcloud sometimes emits, and `|| true` keeps an absent grant from ending the script.
LISTABLE_GRANT=$(gcloud storage buckets get-iam-policy "gs://$PUBLIC_MEDIA_BUCKET" --flatten="bindings[].members" \
    --format="csv[no-heading](bindings.role,bindings.members)" | tr -d '\r' | grep -x "roles/storage.objectViewer,allUsers" || true)
if [ -n "$LISTABLE_GRANT" ]; then
    gcloud storage buckets remove-iam-policy-binding "gs://$PUBLIC_MEDIA_BUCKET" --member=allUsers --role="roles/storage.objectViewer"
fi
gcloud storage buckets update "gs://$PUBLIC_MEDIA_BUCKET" --cors-file="$(dirname "$0")/cors.json"

echo "== runtime service account =="
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 || \
    gcloud iam service-accounts create adlens-run --display-name="AdLens Cloud Run runtime"
# Vertex (Gemini), read/write the uploads bucket, and sign V4 URLs (signBlob on itself).
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" --role="roles/aiplatform.user"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNTIME_SA" --role="roles/storage.objectAdmin"
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$RUNTIME_SA" --role="roles/iam.serviceAccountTokenCreator"
# The API launches the analysis job as itself, so it must be able to act as the runtime SA.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$RUNTIME_SA" --role="roles/iam.serviceAccountUser"

echo "== secrets: build/update the API_SECRETS bundle =="
gcloud secrets describe "$SECRETS_BUNDLE" >/dev/null 2>&1 || \
    gcloud secrets create "$SECRETS_BUNDLE" --replication-policy=automatic

# Every helper below emits its result with a trailing SENTINEL byte, never stripped internally: `$(...)` always
# discards every trailing newline a captured command printed, so a secret value that itself ends with one or more
# newlines would otherwise come back truncated — silently, and differently run to run, which made an unchanged
# bundle re-prompt forever. Appending one fixed, non-newline byte after the real value and stripping exactly that
# one trailing byte back off in bash (`${v%$SENTINEL}`), at the point each value is finally used, makes every round
# trip exact no matter what the value itself ends with.
SENTINEL='x'

# Decodes a base64url secret payload fetched with --format="get(payload.data)", which returns the raw API field
# instead of running it through gcloud's own text-mode stdout decoding — the thing that turns an embedded \n into
# \r\n on Windows. Used for every secret payload this script reads, so no path depends on gcloud's text output.
decode_secret_payload() {
    node -e '
        let input = ""
        process.stdin.on("data", (chunk) => { input += chunk })
        process.stdin.on("end", () => {
            const value = Buffer.from(input.trim(), "base64url").toString("utf8")
            process.stdout.write(value + "x")
        })
    '
}

# An ENABLED version must exist before we try to read one: a secret with none yet is not a read failure (use {}),
# but a real read failure once one exists must abort, not silently become an empty bundle. `tr -d '\r'` strips the
# CRLF Git Bash's gcloud sometimes emits. The read below targets this exact version instead of re-resolving `latest`
# (matching what the prune step keeps); gcloud prints `value(name)` as the bare version number, so it names the secret.
LATEST_ENABLED_VERSION=$(gcloud secrets versions list "$SECRETS_BUNDLE" --filter="state=ENABLED" \
    --sort-by="~createTime" --limit=1 --format="value(name)" | tr -d '\r')

if [ -n "$LATEST_ENABLED_VERSION" ]; then
    CURRENT_BUNDLE_JSON=$(gcloud secrets versions access "$LATEST_ENABLED_VERSION" --secret="$SECRETS_BUNDLE" \
        --format="get(payload.data)" | decode_secret_payload)
    CURRENT_BUNDLE_JSON="${CURRENT_BUNDLE_JSON%$SENTINEL}"
    IS_FIRST_VERSION=0
else
    CURRENT_BUNDLE_JSON='{}'
    IS_FIRST_VERSION=1
fi

# Validates the bundle is a JSON object of strings whose keys are all known, and re-serializes it with sorted keys
# so later comparisons don't depend on key order. Never prints what failed to parse — only a fixed message — and a
# key BUNDLE_KEYS doesn't know about fails loudly instead of being silently dropped (which would rewrite the bundle
# on every run). Takes the bundle on stdin, never as an argument or an env var, which Git Bash rewrites when a
# value looks like a POSIX path.
normalize_bundle_json() {
    BUNDLE_KEYS="$BUNDLE_KEYS" node -e '
        const allowed = new Set((process.env.BUNDLE_KEYS || "").split(" ").filter(Boolean))
        let input = ""
        process.stdin.on("data", (chunk) => { input += chunk })
        process.stdin.on("end", () => {
            let parsed
            try {
                parsed = JSON.parse(input || "{}")
            } catch {
                console.error("API_SECRETS latest version is not a JSON object of strings")
                process.exit(1)
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                console.error("API_SECRETS latest version is not a JSON object of strings")
                process.exit(1)
            }
            const unknown = []
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value !== "string") {
                    console.error("API_SECRETS latest version is not a JSON object of strings")
                    process.exit(1)
                }
                if (!allowed.has(key)) unknown.push(key)
            }
            if (unknown.length > 0) {
                console.error(
                    `API_SECRETS has keys BUNDLE_KEYS does not list: ${unknown.sort().join(", ")}. ` +
                    "Add them to BUNDLE_KEYS in infra/setup.sh, or remove them from the bundle by hand.",
                )
                process.exit(1)
            }
            process.stdout.write(JSON.stringify(parsed, Object.keys(parsed).sort()))
        })
    '
}

CURRENT_BUNDLE_NORMALIZED=$(printf '%s' "$CURRENT_BUNDLE_JSON" | normalize_bundle_json)
unset CURRENT_BUNDLE_JSON

# Reads one key out of $CURRENT_BUNDLE_NORMALIZED, given on stdin (never an env var or an argument). Emits the
# value with the trailing SENTINEL, like every other helper above — the caller strips it.
bundle_value() {
    printf '%s' "$CURRENT_BUNDLE_NORMALIZED" | KEY="$1" node -e '
        let input = ""
        process.stdin.on("data", (chunk) => { input += chunk })
        process.stdin.on("end", () => {
            let bundle
            try {
                bundle = JSON.parse(input || "{}")
            } catch {
                console.error("API_SECRETS latest version is not a JSON object of strings")
                process.exit(1)
            }
            const value = bundle[process.env.KEY]
            if (typeof value === "string") process.stdout.write(value + "x")
        })
    '
}

# Migration only: before the bundle, each key was its own secret. A missing secret means "never had one" (skip);
# an existing one that can't be read is a real problem, so this never silently drops a value that exists. The
# payload travels through decode_secret_payload like every other read, with the SENTINEL left for the caller.
legacy_secret_value() {
    gcloud secrets describe "$1" >/dev/null 2>&1 || return 0
    gcloud secrets versions access latest --secret="$1" --format="get(payload.data)" | decode_secret_payload
}

# Emits .env.production's non-empty KEY=value pairs NUL-delimited (like build_bundle_json below, so a value round-trips
# exactly). Values are literal: a secret may contain `#`, which dotenv-style parsers treat as a comment and silently
# cut. The file arrives on stdin, never as a path argument, which Git Bash rewrites. Errors name a line number or a
# key, never a value.
env_file_pairs() {
    BUNDLE_KEYS="$BUNDLE_KEYS" node -e '
        const allowed = new Set((process.env.BUNDLE_KEYS || "").split(" ").filter(Boolean))
        let input = ""
        process.stdin.on("data", (chunk) => { input += chunk })
        process.stdin.on("end", () => {
            const pairs = []
            const unknown = []
            input.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, index) => {
                if (line.trim() === "" || line.trim().startsWith("#")) return
                const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
                if (!match) {
                    console.error(`.env.production line ${index + 1} is not KEY=value`)
                    process.exit(1)
                }
                const [, key, raw] = match
                const trimmed = raw.trim()
                const value = /^(["\x27]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
                if (!allowed.has(key)) unknown.push(key)
                else if (value !== "") pairs.push(key, value)
            })
            if (unknown.length > 0) {
                console.error(`.env.production has keys BUNDLE_KEYS does not list: ${unknown.sort().join(", ")}`)
                process.exit(1)
            }
            process.stdout.write(pairs.map((part) => part + "\u0000").join(""))
        })
    ' < "$ENV_FILE"
}

declare -A FILE_VALUE

if [ -f "$ENV_FILE" ]; then
    if git ls-files --error-unmatch -- "$ENV_FILE" >/dev/null 2>&1; then
        echo ".env.production is tracked by git; untrack it (git rm --cached .env.production) and re-run." >&2
        exit 1
    fi

    # Run once on its own so a malformed file stops the script: a failure inside the process substitution below
    # wouldn't.
    env_file_pairs >/dev/null
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
        FILE_VALUE[$key]="$value"
    done < <(env_file_pairs)
    echo "Read ${#FILE_VALUE[@]} key(s) from .env.production."
else
    echo "No .env.production: keeping the bundle's keys, or migrating the legacy secrets."
fi

declare -A RESOLVED_VALUE
declare -A RESOLVED_SOURCE

for name in $BUNDLE_KEYS; do
    if [ -n "${FILE_VALUE[$name]:-}" ]; then
        RESOLVED_VALUE[$name]="${FILE_VALUE[$name]}"
        RESOLVED_SOURCE[$name]=.env.production
        continue
    fi

    current_value=$(bundle_value "$name")
    current_value="${current_value%$SENTINEL}"
    if [ -n "$current_value" ]; then
        RESOLVED_VALUE[$name]="$current_value"
        RESOLVED_SOURCE[$name]=bundle
        continue
    fi

    legacy_value=$(legacy_secret_value "$name")
    legacy_value="${legacy_value%$SENTINEL}"
    if [ -n "$legacy_value" ]; then
        RESOLVED_VALUE[$name]="$legacy_value"
        RESOLVED_SOURCE[$name]=legacy
    fi
done

for name in $REQUIRED_KEYS; do
    if [ -z "${RESOLVED_VALUE[$name]:-}" ]; then
        echo "Missing required secret: $name — add it to .env.production and re-run (see the header comment)." >&2
        exit 1
    fi
done

# Builds the bundle's JSON from RESOLVED_VALUE on stdin, NUL-delimited (a bash variable can never contain a NUL
# byte, so it's a safe separator even for a value with a newline in it). No secret ever touches a child process's
# argv or environment — only this pipe — so Git Bash's POSIX-path rewriting can't reach it.
build_bundle_json() {
    {
        for name in $BUNDLE_KEYS; do
            if [ -n "${RESOLVED_SOURCE[$name]:-}" ]; then
                printf '%s\0%s\0' "$name" "${RESOLVED_VALUE[$name]}"
            fi
        done
    } | node -e '
        const chunks = []
        process.stdin.on("data", (chunk) => chunks.push(chunk))
        process.stdin.on("end", () => {
            const parts = Buffer.concat(chunks).toString("utf8").split("\u0000")
            const bundle = {}
            for (let i = 0; i + 1 < parts.length; i += 2) {
                bundle[parts[i]] = parts[i + 1]
            }
            process.stdout.write(JSON.stringify(bundle, Object.keys(bundle).sort()))
        })
    '
}

NEW_BUNDLE_JSON=$(build_bundle_json)

if [ "$NEW_BUNDLE_JSON" != "$CURRENT_BUNDLE_NORMALIZED" ]; then
    if [ "$IS_FIRST_VERSION" = "1" ]; then
        echo "API_SECRETS was just created and has no version yet. About to write its first version."
    else
        echo "About to write a new API_SECRETS version."
    fi
    echo "Source of each key (never the value):"
    for name in $BUNDLE_KEYS; do
        echo "  $name: ${RESOLVED_SOURCE[$name]:-absent}"
    done
    # A closed or redirected stdin (no TTY) makes `read` fail; treat that the same as a no, rather than letting
    # set -e kill the script with no explanation.
    read -r -p "Write this bundle to API_SECRETS? [y/N] " CONFIRM_WRITE || CONFIRM_WRITE=''
    case "$CONFIRM_WRITE" in
        y | Y | yes) : ;;
        *)
            echo "Aborted: API_SECRETS was not written." >&2
            exit 1
            ;;
    esac
    printf '%s' "$NEW_BUNDLE_JSON" | gcloud secrets versions add "$SECRETS_BUNDLE" --data-file=-
fi

unset CURRENT_BUNDLE_NORMALIZED NEW_BUNDLE_JSON RESOLVED_VALUE RESOLVED_SOURCE IS_FIRST_VERSION

gcloud secrets add-iam-policy-binding "$SECRETS_BUNDLE" --member="serviceAccount:$RUNTIME_SA" --role="roles/secretmanager.secretAccessor"

echo "== image repository =="
gcloud artifacts repositories describe "$IMAGE_REPO" --location="$REGION" >/dev/null 2>&1 || \
    gcloud artifacts repositories create "$IMAGE_REPO" --repository-format=docker --location="$REGION" \
        --description="AdLens container images"
# Every CI deploy pushes a new image and nothing else deletes one. Keep the 5 newest (the live one and recent rollback
# targets); delete any other once it is 14 days old. A keep rule wins over a delete rule.
gcloud artifacts repositories set-cleanup-policies "$IMAGE_REPO" --location="$REGION" \
    --policy="$(dirname "$0")/artifact-cleanup-policy.json" --no-dry-run

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

echo "== build one image for both jobs and the API =="
TAG="manual-$(git rev-parse --short HEAD)"
gcloud builds submit --tag "$IMAGE:$TAG" .
IMAGE_REF="$IMAGE@$(gcloud artifacts docker images describe "$IMAGE:$TAG" --format='value(image_summary.digest)')"

echo "== deploy analysis worker job (on-demand; runs dist/worker to completion, retried twice) =="
# Same bundle, same path, as the API: one runtime SA runs both today. Split into two secrets when the worker gets
# its own identity, so each mounts only what it needs.
gcloud run jobs deploy "$ANALYZE_JOB" --image="$IMAGE_REF" --region="$REGION" --service-account="$RUNTIME_SA" \
    --command="node" --args="dist/worker" --tasks=1 --max-retries=2 --task-timeout=15m \
    --cpu=1 --memory=1Gi \
    --set-secrets="$SECRETS_PATH=$SECRETS_BUNDLE:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,GEMINI_LOCATION=global,ANALYZE_MAX_RETRIES=2,SECRETS_FILE=$SECRETS_PATH,LOG_FORMAT=json"
# The API executes this job as the runtime SA. run.developer on the job includes run.jobs.run; narrow
# to a custom role with only run.jobs.run + run.executions.get if you prefer (verify with a dry run).
gcloud run jobs add-iam-policy-binding "$ANALYZE_JOB" --region="$REGION" \
    --member="serviceAccount:$RUNTIME_SA" --role="roles/run.developer"

echo "== deploy cleanup job (daily; runs dist/cleanup, no retries: the next day's run catches up) =="
gcloud run jobs deploy "$CLEANUP_JOB" --image="$IMAGE_REF" --region="$REGION" --service-account="$RUNTIME_SA" \
    --command="node" --args="dist/cleanup" --tasks=1 --max-retries=0 --task-timeout=10m \
    --cpu=1 --memory=512Mi \
    --set-secrets="$SECRETS_PATH=$SECRETS_BUNDLE:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,SECRETS_FILE=$SECRETS_PATH,LOG_FORMAT=json"
# Cloud Scheduler starts the job as the runtime SA, which needs only run.invoker on this one job.
gcloud run jobs add-iam-policy-binding "$CLEANUP_JOB" --region="$REGION" \
    --member="serviceAccount:$RUNTIME_SA" --role="roles/run.invoker"
if gcloud scheduler jobs describe "$CLEANUP_JOB" --location="$REGION" >/dev/null 2>&1; then
    SCHEDULER_VERB=update
else
    SCHEDULER_VERB=create
fi
gcloud scheduler jobs "$SCHEDULER_VERB" http "$CLEANUP_JOB" --location="$REGION" \
    --schedule="$CLEANUP_SCHEDULE" --time-zone="Etc/UTC" \
    --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$CLEANUP_JOB:run" \
    --http-method=POST --oauth-service-account-email="$RUNTIME_SA"

echo "== deploy database job (after every deploy; runs dist/db --apply, no retries: a failure fails the deploy) =="
# Started by CI as the deploy SA (run.developer) and below by this script; nothing else needs to run it.
gcloud run jobs deploy "$DB_JOB" --image="$IMAGE_REF" --region="$REGION" --service-account="$RUNTIME_SA" \
    --command="node" --args="dist/db,--apply" --tasks=1 --max-retries=0 --task-timeout=30m \
    --cpu=1 --memory=512Mi \
    --set-secrets="$SECRETS_PATH=$SECRETS_BUNDLE:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,SECRETS_FILE=$SECRETS_PATH,LOG_FORMAT=json"

echo "== deploy API (served at $API_URL through a Cloud Run domain mapping) =="
# Pinned so a re-created service can't fall back to Cloud Run's defaults (up to 100 instances). 3 instances × 80
# concurrent requests is far above the traffic, and caps what a flood can cost and how many MongoDB connections the
# API can open. CPU is billed only while a request is in flight: Ably, not the API, holds the browsers' live
# connections.
gcloud run deploy "$API_SVC" --image="$IMAGE_REF" --region="$REGION" --service-account="$RUNTIME_SA" \
    --allow-unauthenticated \
    --min-instances=0 --max-instances=3 --concurrency=80 --timeout=300 \
    --cpu=1 --memory=512Mi --cpu-throttling \
    --set-secrets="$SECRETS_PATH=$SECRETS_BUNDLE:latest" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,STORAGE_BUCKET=$BUCKET,PUBLIC_MEDIA_BUCKET=$PUBLIC_MEDIA_BUCKET,WEB_ORIGIN=$WEB_ORIGIN,BETTER_AUTH_URL=$API_URL,COOKIE_DOMAIN=$COOKIE_DOMAIN,GEMINI_LOCATION=global,GCP_REGION=$REGION,ANALYZE_JOB_NAME=$ANALYZE_JOB,GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID,GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID,SECRETS_FILE=$SECRETS_PATH,LOG_FORMAT=json"

echo "== update the database (migrations, indexes, validators), once the code that reads both shapes is live =="
gcloud run jobs execute "$DB_JOB" --region="$REGION" --wait

echo "== prune old API_SECRETS versions (the free tier counts disabled versions too) =="
# CI and this script always roll forward from :latest, so nothing needs an old version — ENABLED or DISABLED. Keep
# only the version :latest itself resolves to (the newest ENABLED one); destroy every other non-destroyed version.
# `tr -d '\r'` strips the CRLF Git Bash's gcloud sometimes emits.
ALL_VERSIONS=$(gcloud secrets versions list "$SECRETS_BUNDLE" --filter="state!=DESTROYED" --sort-by="~createTime" \
    --format="value(name.basename())" | tr -d '\r')
LATEST_ENABLED=$(gcloud secrets versions list "$SECRETS_BUNDLE" --filter="state=ENABLED" --sort-by="~createTime" \
    --limit=1 --format="value(name.basename())" | tr -d '\r')

if [ -z "$LATEST_ENABLED" ]; then
    # No ENABLED version to keep — pruning here could destroy every version there is. Skip it; the next successful
    # run (once a version is ENABLED again) will catch up.
    echo "Warning: no ENABLED API_SECRETS version found; skipping the prune." >&2
else
    for version in $ALL_VERSIONS; do
        if [ "$version" = "$LATEST_ENABLED" ]; then
            continue
        fi
        gcloud secrets versions destroy "$version" --secret="$SECRETS_BUNDLE" --quiet
    done
fi

echo "Done. The web app's NEXT_PUBLIC_API_BASE_URL is $API_URL"
echo "Once the new revision is verified, delete the legacy individual secrets by hand (never done automatically):"
echo '  for name in MONGODB_URI BETTER_AUTH_SECRET RESEND_API_KEY CONTACT_EMAIL GOOGLE_CLIENT_SECRET GITHUB_CLIENT_SECRET TURNSTILE_SECRET_KEY GEMINI_API_KEY; do gcloud secrets delete "$name" --quiet; done'
