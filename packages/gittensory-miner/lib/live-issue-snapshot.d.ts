import type { LiveIssueSnapshot } from "./submission-freshness-check.js";

// A narrower shape than `typeof fetch` on purpose: this module only ever calls it with a string URL and a
// plain POST init, and the ambient `fetch` type in this repo's TS program is Cloudflare-Workers-flavored
// (RequestInfo<CfProperties> | URL), which is both irrelevant here (this package runs under plain Node) and
// stricter than any real caller needs.
export type LiveIssueSnapshotFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export function fetchLiveIssueSnapshot(
  repoFullName: string,
  issueNumber: number,
  options?: { githubToken?: string; graphqlUrl?: string; fetchImpl?: LiveIssueSnapshotFetch },
): Promise<LiveIssueSnapshot | null>;
