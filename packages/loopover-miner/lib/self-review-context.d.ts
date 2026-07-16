import type { SelfReviewContext, FocusManifest } from "@loopover/engine";

// `bounties` is always omitted (see this file's own header comment for why), so the result is
// SelfReviewContext minus that optional field rather than the full type. `issueQuality` is populated (#6057).
export type SelfReviewContextResult = Omit<SelfReviewContext, "bounties">;

// A narrower shape than `typeof fetch` on purpose: this module only ever calls it with a string URL and a
// plain GET init, and the ambient `fetch` type in this repo's TS program is Cloudflare-Workers-flavored
// (RequestInfo<CfProperties> | URL), which is both irrelevant here (this package runs under plain Node) and
// stricter than any real caller needs -- same rationale as live-issue-snapshot.js's own LiveIssueSnapshotFetch.
export type SelfReviewContextFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export type LiveGateThresholdFields = {
  confidence_floor: number | null;
  scope_cap_files: number | null;
  scope_cap_lines: number | null;
};

export type LoopoverBackendSessionAuth = {
  apiUrl?: string;
  sessionToken: string;
};

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
  requestTimeoutMs?: number;
  /** Short ORB live-gate-thresholds probe budget (#6487). Default 400ms. */
  liveGateProbeTimeoutMs?: number;
  /** Explicit session auth for the ORB probe; `null` forces standalone (skip probe). */
  loopoverAuth?: LoopoverBackendSessionAuth | null;
  /** Env used to resolve loopover-mcp session when `loopoverAuth` is omitted. */
  env?: NodeJS.ProcessEnv;
};

export function parseLiveGateThresholdFields(payload: unknown): LiveGateThresholdFields | null;

export function applyLiveGateThresholdsToManifest(
  manifest: FocusManifest,
  fields: LiveGateThresholdFields | null,
): FocusManifest;

export function fetchSelfReviewContext(repoFullName: string, options?: FetchSelfReviewContextOptions): Promise<SelfReviewContextResult>;
