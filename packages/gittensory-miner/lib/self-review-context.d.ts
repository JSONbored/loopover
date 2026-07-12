import type { SelfReviewContext } from "@jsonbored/gittensory-engine";

// bounties/issueQuality are always omitted (see this file's own header comment for why), so the result is
// SelfReviewContext minus those two optional fields rather than the full type.
export type SelfReviewContextResult = Omit<SelfReviewContext, "bounties" | "issueQuality">;

// A narrower shape than `typeof fetch` on purpose: this module only ever calls it with a string URL and a
// plain GET init, and the ambient `fetch` type in this repo's TS program is Cloudflare-Workers-flavored
// (RequestInfo<CfProperties> | URL), which is both irrelevant here (this package runs under plain Node) and
// stricter than any real caller needs -- same rationale as live-issue-snapshot.js's own LiveIssueSnapshotFetch.
export type SelfReviewContextFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type FetchSelfReviewContextOptions = {
  githubToken?: string;
  contributorLogin?: string;
  linkedIssues?: number[];
  apiBaseUrl?: string;
  rawContentBaseUrl?: string;
  gittensorApiBase?: string;
  fetchImpl?: SelfReviewContextFetch;
  perPage?: number;
  maxPages?: number;
};

export function fetchSelfReviewContext(repoFullName: string, options?: FetchSelfReviewContextOptions): Promise<SelfReviewContextResult>;
