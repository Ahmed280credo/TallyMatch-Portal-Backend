#!/usr/bin/env bash
# Uploads the 5 sample bundle PDFs to a staging deployment's /invoices/upload
# endpoint so extraction quality can be checked before Phase 2. Each upload
# is async (202 Accepted, queued job) — the worker does the actual
# extraction. See scripts/README-bundle-sample.md for the full checklist,
# including the SQL to pull extraction_metadata + findings back out once
# the worker has processed them.
#
# Required env vars:
#   STAGING_API_URL   e.g. https://tallymatch-backend-staging.onrender.com/api/v1
#   STAGING_TOKEN      Supabase auth bearer token for a user in the target org
#   STAGING_ORG_ID     the org's UUID (must have extraction_v2_enabled = true)
#
# Usage:
#   STAGING_API_URL=... STAGING_TOKEN=... STAGING_ORG_ID=... \
#     ./scripts/run-bundle-sample.sh /path/to/sample-pdfs-dir
#
# The sample dir is expected to contain these 5 files (rename to match, or
# edit the FILES array below):
#   sea-prince-16717.pdf
#   nestle-1073578903.pdf
#   hyatt-inv1530289.pdf
#   sea-prince-17025.pdf
#   shahbaz-883.pdf

set -euo pipefail

: "${STAGING_API_URL:?Set STAGING_API_URL}"
: "${STAGING_TOKEN:?Set STAGING_TOKEN}"
: "${STAGING_ORG_ID:?Set STAGING_ORG_ID}"

SAMPLE_DIR="${1:?Usage: $0 <dir-containing-sample-pdfs>}"

FILES=(
  "sea-prince-16717.pdf"
  "nestle-1073578903.pdf"
  "hyatt-inv1530289.pdf"
  "sea-prince-17025.pdf"
  "shahbaz-883.pdf"
)

for f in "${FILES[@]}"; do
  path="$SAMPLE_DIR/$f"
  if [ ! -f "$path" ]; then
    echo "SKIP (not found): $path"
    continue
  fi
  echo "=== Uploading $f ==="
  curl -sS -X POST "$STAGING_API_URL/invoices/upload" \
    -H "Authorization: Bearer $STAGING_TOKEN" \
    -H "x-org-id: $STAGING_ORG_ID" \
    -F "document=@${path};type=application/pdf" \
    -w "\nHTTP %{http_code}\n\n"
done

echo "All uploads submitted. Give the worker a minute, then run the SQL in"
echo "scripts/README-bundle-sample.md to pull extraction_metadata + findings."
