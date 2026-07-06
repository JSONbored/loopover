import { githubRateLimitAdmissionKeyForPublicToken, timeoutFetch } from "../github/client";
import { LOW_REST_RATE_LIMIT_REMAINING, shouldWaitForGitHubRateLimit } from "../github/rate-limit";

function upstreamCommitHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Resolve an upstream ref (branch/tag) to its immutable HEAD commit SHA — the pin recorded by BOTH the
 * scoring-model refresh (`refreshScoringModelSnapshot`) and the upstream-drift refresh. It was fetched twice per
 * hour (one `GET /repos/{repo}/commits/{ref}` in each of those hourly jobs). This is the single shared resolver so:
 *
 *   - **Dedup:** both jobs issue the identical bare `/commits/{ref}` read through `timeoutFetch`, which the
 *     self-host GitHub response cache serves from its short-TTL `commit` class — so within a window the ref
 *     resolves ONCE (a cache hit for the second job) instead of twice.
 *   - **Budget-gate:** it yields (returns null) when the shared REST budget is at/below the low-water floor, so
 *     this best-effort audit resolve never spends a scarce request during a rate-limit crunch (the same hourly
 *     window where the heavy maintenance fan-out runs).
 *
 * Fail-open: a rate-limit yield, a network/parse error, a non-OK status, or a missing SHA all return null — every
 * caller already treats null as "fall back to the mutable ref", so a resolve failure never blocks the refresh.
 */
export async function resolveUpstreamCommitSha(
  env: Env,
  config: { repo: string; ref: string },
): Promise<string | null> {
  try {
    const response = await timeoutFetch(
      `https://api.github.com/repos/${config.repo}/commits/${encodeURIComponent(config.ref)}`,
      {
        headers: upstreamCommitHeaders(env.GITHUB_PUBLIC_TOKEN),
        // Budget-gate the NETWORK read only: a cached resolve is still served for free even under pressure; a fresh
        // read is skipped (→ synthetic non-OK → null → caller falls back to the mutable ref) when the REST budget is
        // at/below the low-water floor. This callback runs ONLY on a cache miss, so it never suppresses a cache hit.
        // Scoped to the public-token bucket (#audit-rate-scoping) — the same bucket the read below actually draws
        // from — so an installation's unrelated budget can never mask or falsely trip this gate.
        githubSkipNetworkWhen: () => shouldWaitForGitHubRateLimit(env, LOW_REST_RATE_LIMIT_REMAINING, githubRateLimitAdmissionKeyForPublicToken()).then(Boolean),
        // Give this bare-commit read the same stable, distinctly-scoped cache-key identity every installation-token
        // read gets, so the shared public token rotating doesn't reset this cacheable "commit" class either (#2538).
        githubRateLimitAdmissionKey: githubRateLimitAdmissionKeyForPublicToken(),
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { sha?: string };
    return typeof data.sha === "string" && data.sha.length > 0 ? data.sha : null;
  } catch {
    return null;
  }
}
