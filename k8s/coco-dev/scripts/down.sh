#!/usr/bin/env bash
# Idempotent teardown for ./up.sh -- deletes the whole `kind` cluster (the Helm release, the KBS deployment,
# and every namespace all go with it, since they exist only inside that disposable cluster). Never touches
# the locally generated key material under kbs/ -- re-running up.sh reuses the same keys, matching upstream
# Trustee's own deploy-kbs.sh behavior of only ever generating a key that's missing.
set -euo pipefail

CLUSTER_NAME="${COCO_DEV_KIND_CLUSTER:-coco-dev}"

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "down: deleting kind cluster '${CLUSTER_NAME}'"
  kind delete cluster --name "${CLUSTER_NAME}"
else
  echo "down: kind cluster '${CLUSTER_NAME}' does not exist, nothing to do"
fi
