#!/usr/bin/env bash
# Deploys Isabella's log to Cloud Run with Firestore, in YOUR Google Cloud project.
# Usage:  PROJECT_ID=my-project ./deploy.sh
# Safe to re-run: it updates the service and keeps existing data and secrets.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=my-project ./deploy.sh}"
REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-isabella}"
SA_NAME="isabella-run"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling services"
gcloud services enable run.googleapis.com firestore.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com

echo "==> Firestore database"
if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  gcloud firestore databases create --database="(default)" --location="${FIRESTORE_LOCATION:-nam5}" --type=firestore-native
fi

echo "==> Service account (can only read/write Firestore and read its two secrets)"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="Isabella log"
  sleep 10
fi
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA}" \
  --role="roles/datastore.user" --condition=None >/dev/null

echo "==> Secrets"
if ! gcloud secrets describe isabella-passcode >/dev/null 2>&1; then
  while :; do
    read -r -s -p "Choose a family passcode (12+ characters): " PASS; echo
    [ "${#PASS}" -ge 12 ] && break
    echo "Too short."
  done
  printf '%s' "$PASS" | gcloud secrets create isabella-passcode --data-file=- --replication-policy=automatic
fi
if ! gcloud secrets describe isabella-session >/dev/null 2>&1; then
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets create isabella-session --data-file=- --replication-policy=automatic
fi
if ! gcloud secrets describe isabella-cron >/dev/null 2>&1; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create isabella-cron --data-file=- --replication-policy=automatic
fi
for s in isabella-passcode isabella-session isabella-cron; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
done

echo "==> Deploying"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --service-account "$SA" \
  --set-secrets "PASSCODE=isabella-passcode:latest,SESSION_SECRET=isabella-session:latest,CRON_KEY=isabella-cron:latest" \
  --set-env-vars "TZ_NAME=${TZ_NAME:-America/Phoenix}" \
  --memory 256Mi --max-instances 2

echo "==> Feed-reminder check every 5 minutes"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
CRON="$(gcloud secrets versions access latest --secret=isabella-cron)"
if gcloud scheduler jobs describe isabella-reminders --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http isabella-reminders --location "$REGION" --schedule "*/5 * * * *" \
    --uri "${URL}/api/cron/reminders" --http-method POST --update-headers "X-Cron-Key=${CRON}" >/dev/null
else
  gcloud scheduler jobs create http isabella-reminders --location "$REGION" --schedule "*/5 * * * *" \
    --uri "${URL}/api/cron/reminders" --http-method POST --headers "X-Cron-Key=${CRON}" >/dev/null
fi

echo
echo "Done. Open the URL above, sign in, and tap a button."
echo "To put it on isabella.family, see 'Custom domain' in README.md."
