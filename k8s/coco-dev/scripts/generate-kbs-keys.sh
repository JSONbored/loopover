#!/usr/bin/env bash
# Generate the local-only KBS admin keypair and dev workload secret, exactly matching upstream Trustee's
# own kbs/config/kubernetes/deploy-kbs.sh procedure. Idempotent: skips generation for any file that already
# exists, so re-running never rotates a key silently. None of this is real production key material -- it is
# a fresh ed25519 admin keypair authorizing calls against a throwaway `kind` cluster, and a dev workload
# secret KBS will release to an attested guest. See ../.gitignore: none of these three files are committed.
set -euo pipefail

COCO_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KBS_KEY="${COCO_DEV_DIR}/kbs/base/kbs.key"
KBS_CERT="${COCO_DEV_DIR}/kbs/base/kbs.pem"
WORKLOAD_KEY="${COCO_DEV_DIR}/kbs/overlays/dev/key.bin"

if [[ -f "${KBS_CERT}" ]]; then
  echo "generate-kbs-keys: ${KBS_CERT} already exists, leaving it in place"
else
  openssl genpkey -algorithm ed25519 -out "${KBS_KEY}"
  openssl pkey -in "${KBS_KEY}" -pubout -out "${KBS_CERT}"
  echo "generate-kbs-keys: wrote ${KBS_KEY} and ${KBS_CERT}"
fi

if [[ -f "${WORKLOAD_KEY}" ]]; then
  echo "generate-kbs-keys: ${WORKLOAD_KEY} already exists, leaving it in place"
else
  openssl rand -out "${WORKLOAD_KEY}" 32
  echo "generate-kbs-keys: wrote ${WORKLOAD_KEY}"
fi
