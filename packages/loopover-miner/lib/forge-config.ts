/** Per-tenant forge configuration (#4784): the GitHub-specific protocol details that discovery used to hardcode,
 * gathered behind one resolver so a non-github.com tenant (GitHub Enterprise, or another GitHub-compatible forge)
 * can override them. loopover's own github.com conventions survive only as `DEFAULT_FORGE_CONFIG` — calling
 * `resolveForgeConfig()` with no overrides is byte-identical to the pre-#4784 hardcoded fan-out behavior, which is
 * what keeps the existing loopover discovery path unchanged. Executes the #4780 repo-agnostic-capability-audit
 * checklist (forge abstraction, configurable credential env var, configurable user-agent). */

/** Per-tenant forge configuration (#4784). Every field is a string knob defaulting to the github.com value in
 * `DEFAULT_FORGE_CONFIG`; a tenant overrides only what differs for their forge. */
export type ForgeConfig = {
  apiBaseUrl: string;
  apiVersion: string;
  apiVersionHeader: string;
  acceptHeader: string;
  userAgent: string;
  repoPathPrefix: string;
  searchEndpoint: string;
  searchQualifiers: string;
  tokenEnvVar: string;
};

/** The github.com defaults every forge field falls back to. Frozen so a caller can't mutate the shared baseline. */
export const DEFAULT_FORGE_CONFIG: Readonly<ForgeConfig> = Object.freeze({
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

function trimmedStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Resolve a full forge config from partial per-tenant overrides. Every field is an independent string knob that
 * falls back to its github.com default when the override is missing, non-string, or blank — so a partial override
 * (say, only `apiBaseUrl` for a GitHub Enterprise host) still yields a complete, usable config.
 */
export function resolveForgeConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  const resolved = {} as ForgeConfig;
  for (const key of Object.keys(DEFAULT_FORGE_CONFIG) as Array<keyof ForgeConfig>) {
    resolved[key] = trimmedStringOr(source[key], DEFAULT_FORGE_CONFIG[key]);
  }
  return resolved;
}
