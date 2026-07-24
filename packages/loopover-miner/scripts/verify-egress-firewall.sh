#!/bin/bash
# Real, empirical proof that #7857's egress firewall actually enforces something -- builds the real Docker
# image, runs the real entrypoint setup inside a real container with real NET_ADMIN/NET_RAW, and asserts on
# real network calls. This is deliberately NOT part of `npm run test:ci` (vitest can't grant a test process
# NET_ADMIN or build/run Docker images) -- run it manually after touching anything under
# packages/loopover-miner/lib/egress-*.ts, the Dockerfile, or the entrypoint script, or wire it into a
# dedicated CI job that runs `docker build`.
#
# Requires: Docker with NET_ADMIN/NET_RAW support (works on a standard Linux CI runner or Docker Desktop).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE_TAG="loopover-miner:egress-firewall-verify"
FAILURES=0

echo "Building $IMAGE_TAG..."
docker build -f "$REPO_ROOT/packages/loopover-miner/Dockerfile" -t "$IMAGE_TAG" "$REPO_ROOT" >/tmp/egress-verify-build.log 2>&1 \
  || { echo "BUILD FAILED -- see /tmp/egress-verify-build.log"; exit 1; }

# Runs a single fetch inside a fresh container with the given .loopover-ams.yml content (or none), and checks
# whether it matches the expected outcome ("success" or "blocked").
check() {
  local description="$1" ams_yml_content="$2" host="$3" expect="$4" extra_env="${5:-}"
  local config_dir
  config_dir="$(mktemp -d)"
  if [ -n "$ams_yml_content" ]; then
    printf '%s' "$ams_yml_content" > "$config_dir/.loopover-ams.yml"
  fi

  local output
  output=$(docker run --rm --cap-add=NET_ADMIN --cap-add=NET_RAW -v "$config_dir:/data/miner" ${extra_env:+-e "$extra_env"} --entrypoint sh "$IMAGE_TAG" -c "
    set -e
    node /app/packages/loopover-miner/lib/generate-egress-firewall-config.js /etc/dnsmasq.d/loopover-egress.conf /tmp/ruleset.sh >/dev/null
    dnsmasq --conf-file=/etc/dnsmasq.d/loopover-egress.conf --pid-file=/var/run/dnsmasq.pid
    echo 'nameserver 127.0.0.1' > /etc/resolv.conf
    sh /tmp/ruleset.sh
    gosu node node -e 'fetch(\"https://${host}\", {signal: AbortSignal.timeout(8000)}).then(r => console.log(\"RESULT:success\")).catch(e => console.log(\"RESULT:blocked \" + e.message))'
  " 2>/dev/null || true)
  rm -rf "$config_dir"

  local actual="blocked"
  echo "$output" | grep -q "RESULT:success" && actual="success"

  if [ "$actual" = "$expect" ]; then
    echo "PASS: $description (expected $expect, got $actual)"
  else
    echo "FAIL: $description (expected $expect, got $actual)"
    FAILURES=$((FAILURES + 1))
  fi
}

check "default allowlist: github.com (target-repo-git-remote default) succeeds" "" "github.com" "success"
check "default allowlist: an arbitrary host with no config is blocked" "" "example.com" "blocked"
check "default allowlist: npm registry is blocked without the npm ecosystem declared" "" "registry.npmjs.org" "blocked"
check "operator config: npm registry succeeds once ecosystems:[npm] is declared" $'networkAllowlist:\n  ecosystems: [npm]\n  extraHosts: []\n' "registry.npmjs.org" "success"
check "operator config: an operator-declared extraHost succeeds" $'networkAllowlist:\n  ecosystems: []\n  extraHosts: [example.com]\n' "example.com" "success"
check "operator config: an UNDECLARED host still blocked even with other config present" $'networkAllowlist:\n  ecosystems: [npm]\n  extraHosts: []\n' "pypi.org" "blocked"
check "LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL: a normally-blocked host succeeds when the escape hatch is set" "" "example.com" "success" "LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL=1"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All egress-firewall checks passed."
  exit 0
else
  echo "$FAILURES egress-firewall check(s) FAILED."
  exit 1
fi
