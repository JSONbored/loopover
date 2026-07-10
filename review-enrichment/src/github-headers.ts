// Shared outbound GitHub REST API request headers (#4609). Before this, 17 of 63 analyzer files hand-copied a
// private githubHeaders() helper that had drifted into 4 shapes: 11 sent no User-Agent, 3 added a User-Agent +
// a GITHUB_API_VERSION constant, 1 hardcoded Accept to raw-only (unable to ever request JSON), and 2 reinvented a
// raw-toggle param a 4th way. One export, one shape, used by every analyzer that talks to the GitHub API.
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "gittensory-review-enrichment";

/** Standard headers for an authenticated GitHub REST API request: `Authorization`, `X-GitHub-Api-Version`, and
 *  `User-Agent` are always present. `Accept` defaults to the structured-JSON media type; pass `{ raw: true }`
 *  when fetching raw file/blob content (e.g. the Contents API) instead of JSON metadata. Pure. */
export function githubHeaders(
  token: string,
  opts?: { raw?: boolean },
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: opts?.raw ? "application/vnd.github.raw" : "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}
