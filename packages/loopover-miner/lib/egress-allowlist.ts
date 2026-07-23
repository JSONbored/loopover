// Resolves the #7648-ratified network-egress allowlist for AMS sandboxed execution into a concrete list of
// hostnames (#7857's enforcement half -- the config surface this reads, AmsPolicySpec.networkAllowlist, shipped
// separately and was inert until this file). Pure: no IO, no shell/iptables text here (see
// egress-firewall-config.ts for that) -- just "given this operator's declared additions, what hosts are
// actually allowed."
//
// #7648's three ratified categories, and how each is resolved here:
//  1. "OS package registries" -- the miner image's own base (Debian, node:24-slim) apt mirrors. Static: this
//     container's OS never changes at runtime.
//  2. "the target repo's own git remote" -- resolved as the fixed GitHub-family hostname set below, not
//     derived per-attempt from the actual repo being worked on. This product only ever discovers/operates on
//     GitHub-hosted repos (confirmed: no GitLab/Bitbucket path exists anywhere in this codebase) -- treating
//     "the target repo's remote" as "GitHub" is a safe, always-correct simplification for this product, not a
//     narrowing of what #7648 asked for. Revisit if a non-GitHub forge is ever supported.
//  3. "the repo's declared language-ecosystem registries" -- #7648's own text says "the repo's manifest
//     actually declares," but AmsPolicySpec's own header explains why that's unsafe to derive from the TARGET
//     repo: a malicious repo could fabricate a manifest entry to smuggle an attacker-controlled host into its
//     own attempt's allowlist. Resolved instead from the OPERATOR's own declared `networkAllowlist.ecosystems`
//     -- the trust-boundary-safe substitution #7857's own prior research already settled.
//
// Operator-declared `extraHosts` (#7648's "requesting broader access" case) are appended verbatim -- already
// validated against RFC 1123 hostname shape by ams-policy-spec.ts's own parser before they ever reach here.
//
// Beyond #7648's three categories, this firewall applies to the WHOLE container (the coding-agent subprocess
// shares its parent miner process's network namespace -- no per-process isolation exists today, see #7857's own
// research comments), so the MINER's own legitimate outbound calls need to stay allowed too, or this would
// break the miner's real function while trying to sandbox the coding agent. Each such host is added ONLY when
// its corresponding feature is actually configured on this instance -- the same "allow only what's actually
// needed" discipline as everything else here, not a blanket allowance "just in case":
//  - the Orb broker (`ORB_BROKER_URL`, default api.loopover.ai) -- only if broker mode is active
//    (`ORB_ENROLLMENT_SECRET` or #8202/#8246's `LOOPOVER_TENANT_SECRET_TOKEN` is set)
//  - the discovery-index plane (`LOOPOVER_MINER_DISCOVERY_INDEX_URL`) -- only if set (opt-in, no default)
//  - Sentry (`LOOPOVER_MINER_SENTRY_DSN`) -- only if set (opt-in, no default)
//  - Neon's API (console.neon.tech, #7858's per-attempt DB fork) -- only if all three
//    `LOOPOVER_MINER_NEON_*` vars are set, mirroring `resolveAttemptDbForkConfig`'s own all-or-nothing gate
// This is deliberately NOT exhaustive against every possible operator configuration (a fully custom, self-run
// discovery-index/broker fork at a URL this can't anticipate, or some other integration entirely) -- extraHosts
// is the documented escape hatch for anything these defaults miss.
import type { AmsNetworkAllowlist, AmsNetworkAllowlistEcosystem } from "@loopover/engine";

export type EgressAllowlistReason =
  | "os-package-registry"
  | "target-repo-git-remote"
  | `ecosystem:${AmsNetworkAllowlistEcosystem}`
  | "operator-declared"
  | "loopover-platform";

export type EgressAllowlistEntry = {
  host: string;
  reason: EgressAllowlistReason;
};

/** Debian apt mirrors for the miner image's own base (node:24-slim) -- always allowed, unconditionally: the
 *  miner's own OS-level package installs (this file's enforcement setup itself needs `apt-get install`) must
 *  never be blocked by the same firewall it configures. */
const OS_PACKAGE_REGISTRY_HOSTS = ["deb.debian.org", "security.debian.org"];

/** The hostnames git/GitHub operations actually touch: the API, git-over-https clone/fetch, codeload's tarball
 *  endpoint, and githubusercontent for raw-file/asset fetches a coding agent's tooling might reasonably hit. */
const TARGET_REPO_GIT_REMOTE_HOSTS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com"];

/** One or more real registry hostnames per ecosystem #7857's config surface recognizes -- kept in the exact
 *  order AMS_NETWORK_ALLOWLIST_ECOSYSTEMS declares them (ams-policy-spec.ts) so a new ecosystem added there is
 *  a compile error here (an unhandled case in the Record type) rather than a silent gap. */
const ECOSYSTEM_REGISTRY_HOSTS: Record<AmsNetworkAllowlistEcosystem, string[]> = {
  npm: ["registry.npmjs.org"],
  pypi: ["pypi.org", "files.pythonhosted.org"],
  crates: ["crates.io", "static.crates.io", "index.crates.io"],
  go: ["proxy.golang.org", "sum.golang.org"],
  rubygems: ["rubygems.org"],
  packagist: ["repo.packagist.org"],
  maven: ["repo.maven.apache.org"],
  nuget: ["api.nuget.org"],
};

/** Neon's REST API host (`attempt-db-fork.ts`'s own `DEFAULT_API_BASE_URL`) -- fixed, not per-project. */
const NEON_API_HOST = "console.neon.tech";

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Resolve an operator's declared `networkAllowlist` into the full, concrete set of allowed hostnames --
 *  always-on defaults, this operator's own ecosystem/extraHosts additions, and the miner's own platform hosts
 *  (see this file's header) gated behind whichever features `env` shows are actually configured. Deduplicated
 *  by host: an ecosystem's own registry could coincidentally also appear in `extraHosts`, or the broker's
 *  default host could coincidentally equal something else here, and each entry should appear in the output
 *  exactly once (the FIRST reason it was allowed for wins). */
export function resolveEgressAllowlist(networkAllowlist: AmsNetworkAllowlist, env: Record<string, string | undefined> = {}): EgressAllowlistEntry[] {
  const entries: EgressAllowlistEntry[] = [];
  const seen = new Set<string>();
  const add = (host: string, reason: EgressAllowlistReason): void => {
    const normalized = host.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    entries.push({ host: normalized, reason });
  };

  for (const host of OS_PACKAGE_REGISTRY_HOSTS) add(host, "os-package-registry");
  for (const host of TARGET_REPO_GIT_REMOTE_HOSTS) add(host, "target-repo-git-remote");
  for (const ecosystem of networkAllowlist.ecosystems) {
    for (const host of ECOSYSTEM_REGISTRY_HOSTS[ecosystem]) add(host, `ecosystem:${ecosystem}`);
  }
  for (const host of networkAllowlist.extraHosts) add(host, "operator-declared");

  if (env.ORB_ENROLLMENT_SECRET || env.LOOPOVER_TENANT_SECRET_TOKEN) {
    add(hostnameOf(env.ORB_BROKER_URL) ?? "api.loopover.ai", "loopover-platform");
  }
  const discoveryIndexHost = hostnameOf(env.LOOPOVER_MINER_DISCOVERY_INDEX_URL);
  if (discoveryIndexHost) add(discoveryIndexHost, "loopover-platform");
  const sentryHost = hostnameOf(env.LOOPOVER_MINER_SENTRY_DSN);
  if (sentryHost) add(sentryHost, "loopover-platform");
  if (env.LOOPOVER_MINER_NEON_API_KEY && env.LOOPOVER_MINER_NEON_PROJECT_ID && env.LOOPOVER_MINER_NEON_PARENT_BRANCH_ID) {
    add(NEON_API_HOST, "loopover-platform");
  }

  return entries;
}
