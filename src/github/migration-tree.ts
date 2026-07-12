import { PRODUCT_USER_AGENT, timeoutFetch, type GitHubRateLimitAdmissionKey } from "./client";
import { repoParts } from "../utils/json";

const GITHUB_FETCH_TIMEOUT_MS = 10_000;
const MIGRATIONS_PREFIX = "migrations/";

/** Shared GitHub headers for a read call. */
function ghHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": PRODUCT_USER_AGENT,
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * List the `.sql` filenames directly under `migrations/` at `ref` (typically the live tip of the base branch)
 * via the recursive Git Trees API — the same primitive src/review/rag-index.ts's fetchRepoTree uses, but
 * scoped to a single path prefix so a caller doesn't need to re-derive the migrations/-filter logic (#2550).
 * Kept as its own small, single-purpose helper rather than exporting/reusing fetchRepoTree directly — that
 * function is rag-index.ts's own indexing concern (returns the WHOLE tree, unfiltered); coupling this feature
 * to it for one extra call site isn't worth the cross-module dependency.
 *
 * Fail-safe: any non-OK response, network error, or malformed body returns null (never throws). Callers MUST
 * treat null as "recheck inconclusive" and never treat it as evidence of (or absence of) a collision — a live
 * pre-merge safety check must fail OPEN on a read failure, not silently hold every PR whenever GitHub hiccups.
 */
export async function listMigrationFilenamesAtRef(repoFullName: string, ref: string, token: string | undefined, admissionKey: GitHubRateLimitAdmissionKey | undefined): Promise<string[] | null> {
  try {
    const { owner, name } = repoParts(repoFullName);
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const response = await timeoutFetch(url, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      githubRateLimitAdmission: admissionKey !== undefined,
      ...(admissionKey ? { githubRateLimitAdmissionKey: admissionKey } : {}),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tree?: Array<{ path?: string; type?: string }>; truncated?: boolean } | null;
    // A truncated tree (repo exceeds GitHub's ~100k-entry/7MB response cap) can silently omit migrations/
    // entries — treat exactly like a fetch failure (null, fail-open) rather than trusting a possibly-incomplete
    // list, since an incomplete live snapshot is inconclusive, not evidence of "no collision."
    if (body?.truncated === true) return null;
    const filenames: string[] = [];
    for (const node of body?.tree ?? []) {
      if (node.type !== "blob" || typeof node.path !== "string") continue;
      if (!node.path.startsWith(MIGRATIONS_PREFIX)) continue;
      const rest = node.path.slice(MIGRATIONS_PREFIX.length);
      if (rest.length === 0 || rest.includes("/")) continue; // skip nested dirs, defensively — migrations/ is flat
      if (rest.endsWith(".sql")) filenames.push(rest);
    }
    return filenames;
  } catch {
    return null;
  }
}
