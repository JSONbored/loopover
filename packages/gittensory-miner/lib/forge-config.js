/** Per-tenant forge configuration (#4784): the GitHub-specific protocol details that discovery used to hardcode,
 * gathered behind one resolver so a non-github.com tenant (GitHub Enterprise, or another GitHub-compatible forge)
 * can override them. gittensory's own github.com conventions survive only as `DEFAULT_FORGE_CONFIG` — calling
 * `resolveForgeConfig()` with no overrides is byte-identical to the pre-#4784 hardcoded fan-out behavior, which is
 * what keeps the existing gittensory discovery path unchanged. Executes the #4780 repo-agnostic-capability-audit
 * checklist (forge abstraction, configurable credential env var, configurable user-agent). */

/** The github.com defaults every forge field falls back to. Frozen so a caller can't mutate the shared baseline. */
export const DEFAULT_FORGE_CONFIG = Object.freeze({
  apiBaseUrl: "https://api.github.com",
  apiVersion: "2022-11-28",
  apiVersionHeader: "x-github-api-version",
  acceptHeader: "application/vnd.github+json",
  userAgent: "loopover-miner",
  repoPathPrefix: "/repos",
  searchEndpoint: "/search/issues",
  searchQualifiers: "state:open type:issue",
  tokenEnvVar: "GITHUB_TOKEN",
});

function trimmedStringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Resolve a full forge config from partial per-tenant overrides. Every field is an independent string knob that
 * falls back to its github.com default when the override is missing, non-string, or blank — so a partial override
 * (say, only `apiBaseUrl` for a GitHub Enterprise host) still yields a complete, usable config.
 */
export function resolveForgeConfig(overrides = {}) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  const resolved = {};
  for (const [key, fallback] of Object.entries(DEFAULT_FORGE_CONFIG)) {
    resolved[key] = trimmedStringOr(source[key], fallback);
  }
  return resolved;
}
