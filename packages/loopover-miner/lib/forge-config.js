/** Per-tenant forge configuration (#4784): the GitHub-specific protocol details that discovery used to hardcode,
 * gathered behind one resolver so a non-github.com tenant (GitHub Enterprise, or another GitHub-compatible forge)
 * can override them. loopover's own github.com conventions survive only as `DEFAULT_FORGE_CONFIG` — calling
 * `resolveForgeConfig()` with no overrides is byte-identical to the pre-#4784 hardcoded fan-out behavior, which is
 * what keeps the existing loopover discovery path unchanged. Executes the #4780 repo-agnostic-capability-audit
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
    for (const key of Object.keys(DEFAULT_FORGE_CONFIG)) {
        resolved[key] = trimmedStringOr(source[key], DEFAULT_FORGE_CONFIG[key]);
    }
    return resolved;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZm9yZ2UtY29uZmlnLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZm9yZ2UtY29uZmlnLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs4RkFLOEY7QUFnQjlGLG9IQUFvSDtBQUNwSCxNQUFNLENBQUMsTUFBTSxvQkFBb0IsR0FBMEIsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUN2RSxVQUFVLEVBQUUsd0JBQXdCO0lBQ3BDLFVBQVUsRUFBRSxZQUFZO0lBQ3hCLGdCQUFnQixFQUFFLHNCQUFzQjtJQUN4QyxZQUFZLEVBQUUsNkJBQTZCO0lBQzNDLFNBQVMsRUFBRSxnQkFBZ0I7SUFDM0IsY0FBYyxFQUFFLFFBQVE7SUFDeEIsY0FBYyxFQUFFLGdCQUFnQjtJQUNoQyxnQkFBZ0IsRUFBRSx1QkFBdUI7SUFDekMsV0FBVyxFQUFFLGNBQWM7Q0FDNUIsQ0FBQyxDQUFDO0FBRUgsU0FBUyxlQUFlLENBQUMsS0FBYyxFQUFFLFFBQWdCO0lBQ3ZELE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDN0UsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsWUFBa0MsRUFBRTtJQUNyRSxNQUFNLE1BQU0sR0FBRyxTQUFTLElBQUksT0FBTyxTQUFTLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUMzRSxNQUFNLFFBQVEsR0FBRyxFQUFpQixDQUFDO0lBQ25DLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxvQkFBb0IsQ0FBNkIsRUFBRSxDQUFDO1FBQ2hGLFFBQVEsQ0FBQyxHQUFHLENBQUMsR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLG9CQUFvQixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDMUUsQ0FBQztJQUNELE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUMifQ==