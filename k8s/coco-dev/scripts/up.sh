#!/usr/bin/env bash
# Idempotent bring-up for the CoCo no-TEE dev stack (#9213, epic #8534): a local `kind` cluster, the pinned
# confidential-containers Helm chart (dev-only shim override -- see ../helm/values-coco-dev.yaml), and the
# Trustee KBS. Every version/digest below is read from ../versions.json, the single pinned source of truth --
# see ../README.md for why this topology was chosen and what does/doesn't need real SNP hardware.
#
# Requires: kind, kubectl, helm, jq, openssl, docker. Safe to re-run: each step checks the existing state
# before acting, so re-running after a partial failure resumes rather than duplicating work.
set -euo pipefail

COCO_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${COCO_DEV_KIND_CLUSTER:-coco-dev}"
VERSIONS_JSON="${COCO_DEV_DIR}/versions.json"

CHART_REPO="$(jq -r '.cocoHelmChart.repository' "${VERSIONS_JSON}")"
CHART_VERSION="$(jq -r '.cocoHelmChart.version' "${VERSIONS_JSON}")"

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "up: kind cluster '${CLUSTER_NAME}' already exists"
else
  echo "up: creating kind cluster '${CLUSTER_NAME}'"
  kind create cluster --name "${CLUSTER_NAME}"
fi

KUBE_CONTEXT="kind-${CLUSTER_NAME}"

echo "up: installing confidential-containers chart ${CHART_VERSION} (dev-only shim override)"
helm upgrade --install coco "${CHART_REPO}" \
  --version "${CHART_VERSION}" \
  --namespace coco-system --create-namespace \
  -f "${COCO_DEV_DIR}/helm/values-coco-dev.yaml" \
  --kube-context "${KUBE_CONTEXT}"

"${COCO_DEV_DIR}/scripts/generate-kbs-keys.sh"

echo "up: applying KBS manifests"
kubectl apply --context "${KUBE_CONTEXT}" -k "${COCO_DEV_DIR}/kbs/overlays/dev"

echo "up: waiting for the KBS deployment to become available"
kubectl rollout status deployment/kbs --context "${KUBE_CONTEXT}" -n coco-tenant --timeout=180s

echo "up: done. RuntimeClasses in the cluster:"
kubectl get runtimeclass --context "${KUBE_CONTEXT}"
