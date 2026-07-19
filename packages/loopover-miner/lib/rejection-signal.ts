import { resolveAiPolicyVerdict } from "@loopover/engine";
import { listRecentOwnSubmissions } from "./governor-state.js";
import { resolveRejection } from "./rejection-state-machine.js";

// Real rejectionSignaled resolver (#5132, Wave 3.5 follow-up). iterate-policy.ts's own doc comment: "True
// when the target repo (or this contributor's history with it) has signaled it does not want automated/
// AI-authored contributions -- an explicit AI-usage-policy ban, or a prior submission from this same miner
// was closed/rejected on this exact repo. The caller resolves this ... and passes it in; this policy does
// not compute it itself." This module resolves the FIRST trigger: a real AI-USAGE.md/CONTRIBUTING.md ban,
// fetched live and scanned via the engine's own resolveAiPolicyVerdict -- the same check
// opportunity-fanout.js already runs during discovery, applied here at attempt time instead.
//
// The SECOND trigger (a prior submission from this same miner was closed/rejected on this exact repo) is now
// resolved by resolveOwnRejectionHistory (#5655), closing the gap this header previously documented: it checks
// each of this miner's recorded own-submissions on the repo (governor-state.js's listRecentOwnSubmissions,
// #5134) against its live PR outcome via rejection-state-machine.js's resolveRejection (#4278) -- consuming both
// upstream modules without modifying either. resolveRejectionSignaled now returns a trigger-specific reason
// string if EITHER trigger fires (or `false` when neither does), so `rejectionSignaled` finally means what
// iterate-policy.ts's doc comment has always said.

export type RejectionSignaledReason = "ai_usage_policy_ban" | "own_submission_rejected";

export const REJECTION_REASON_AI_USAGE_POLICY_BAN = "ai_usage_policy_ban";
export const REJECTION_REASON_OWN_SUBMISSION_REJECTED = "own_submission_rejected";

const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const MAX_POLICY_DOC_BYTES = 128 * 1024;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
// Bound the per-call PR-status fetch fan-out (#5655): a miner with a long submission history on one repo must
// not trigger an unbounded burst of GitHub API calls on every attempt -- only the N most recent are checked.
const DEFAULT_MAX_REJECTION_HISTORY_CHECKS = 10;

// A narrower shape than `typeof fetch` on purpose (same rationale as live-issue-snapshot.js's own
// LiveIssueSnapshotFetch), but a bit richer than self-review-context.js's own SelfReviewContextFetch: this
// module's policy-doc reader also needs `headers.get()` (content-length bound) and a streaming `body.getReader()`
// (bounded read without loading an oversized response fully into memory first) -- both OPTIONAL here so a
// SelfReviewContextFetch-shaped value (used by fetchPullRequestPayload's plain-JSON callers) still satisfies it.
export type RejectionSignalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers?: { get(name: string): string | null };
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } } | null;
}>;

type RejectionSignalResponse = Awaited<ReturnType<RejectionSignalFetch>>;

type OwnRejectionHistorySubmission = { pullRequestNumber?: number | null | undefined };

type ListOwnSubmissions = (filter: { repoFullName?: string }) => OwnRejectionHistorySubmission[];

export interface OwnRejectionHistoryOptions {
  listSubmissions?: ListOwnSubmissions;
  fetchImpl?: RejectionSignalFetch;
  githubToken?: string;
  githubApiBaseUrl?: string;
  maxRejectionHistoryChecks?: number;
}

export interface RejectionSignaledOptions extends OwnRejectionHistoryOptions {
  rawContentBaseUrl?: string;
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
}

function normalizeOptions(options: RejectionSignaledOptions): { rawContentBaseUrl: string; fetchImpl: RejectionSignalFetch } {
  return {
    rawContentBaseUrl:
      typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
    fetchImpl: options.fetchImpl ?? (fetch as unknown as RejectionSignalFetch),
  };
}

async function readBoundedPolicyDoc(response: RejectionSignalResponse): Promise<string | null> {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== undefined && contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_POLICY_DOC_BYTES) return null;
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    return typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_POLICY_DOC_BYTES ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > MAX_POLICY_DOC_BYTES) {
        await reader.cancel();
        return null;
      }
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchPolicyDoc(
  target: { owner: string; repo: string },
  path: string,
  resolved: { rawContentBaseUrl: string; fetchImpl: RejectionSignalFetch },
): Promise<string | null> {
  const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
  try {
    const response = await resolved.fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "loopover-miner" } });
    if (!response.ok) return null;
    return await readBoundedPolicyDoc(response);
  } catch {
    return null;
  }
}

async function fetchPullRequestPayload(
  target: { owner: string; repo: string },
  prNumber: number,
  resolved: { fetchImpl: RejectionSignalFetch; githubToken: string; githubApiBaseUrl: string },
): Promise<unknown> {
  const url = `${resolved.githubApiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${prNumber}`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "loopover-miner" };
  if (resolved.githubToken) headers.authorization = `Bearer ${resolved.githubToken}`;
  const response = await resolved.fetchImpl(url, { method: "GET", headers });
  if (!response.ok) return null;
  return await response.json();
}

/**
 * Resolve the SECOND `rejectionSignaled` trigger (#5655): has a prior submission from THIS miner on THIS exact
 * repo already been closed/rejected? Reads this miner's own recorded submissions on the repo
 * (`listRecentOwnSubmissions`, #5134), fetches each one's live PR state, and runs it through `resolveRejection`
 * (#4278) -- returning `true` if ANY was closed without merge. Bounded (only the most recent
 * `maxRejectionHistoryChecks` submissions with a real PR number are fetched) and fully fail-open: a wholesale
 * failure to read submissions resolves to `false` (never fabricated as a rejection), and any single PR
 * fetch/parse failure is skipped so it never blocks the others. Consumes both upstream modules without modifying
 * either. Every dependency is injectable for testing.
 */
export async function resolveOwnRejectionHistory(repoFullName: string, options: OwnRejectionHistoryOptions = {}): Promise<boolean> {
  const target = parseRepoFullName(repoFullName);
  if (!target) return false;
  const listSubmissions = options.listSubmissions ?? listRecentOwnSubmissions;
  const resolved = {
    fetchImpl: options.fetchImpl ?? (fetch as unknown as RejectionSignalFetch),
    githubToken: typeof options.githubToken === "string" ? options.githubToken.trim() : (process.env.GITHUB_TOKEN ?? ""),
    githubApiBaseUrl:
      typeof options.githubApiBaseUrl === "string" && options.githubApiBaseUrl.trim() ? options.githubApiBaseUrl.trim() : DEFAULT_GITHUB_API_BASE_URL,
    maxChecks:
      Number.isInteger(options.maxRejectionHistoryChecks) && (options.maxRejectionHistoryChecks as number) > 0
        ? (options.maxRejectionHistoryChecks as number)
        : DEFAULT_MAX_REJECTION_HISTORY_CHECKS,
  };

  let submissions: OwnRejectionHistorySubmission[];
  try {
    submissions = listSubmissions({ repoFullName });
  } catch {
    return false; // wholesale failure to read own submissions -- fail open, never fabricate a rejection
  }
  const checkable = (Array.isArray(submissions) ? submissions : [])
    .filter((submission) => submission && Number.isInteger(submission.pullRequestNumber) && (submission.pullRequestNumber as number) > 0)
    .slice(0, resolved.maxChecks);
  if (checkable.length === 0) return false; // no prior submissions on this repo -- no fetch attempted

  for (const submission of checkable) {
    try {
      const payload = await fetchPullRequestPayload(target, submission.pullRequestNumber as number, resolved);
      if (!payload) continue;
      // No signal (gate/duplicate context isn't available here) -- resolveRejection returns non-null only for a
      // PR that is closed-without-merge, which is exactly the "was it rejected" question this check asks.
      const rejection = resolveRejection(payload, undefined, { repoFullName, prNumber: submission.pullRequestNumber as number });
      if (rejection) return true;
    } catch {
      // Individual PR fetch/parse/classify failure -- skip this one, keep checking the rest (fail open).
    }
  }
  return false;
}

/**
 * Resolve whether the target repo has signaled it does not want automated/AI-authored contributions --
 * either trigger documented above. Returns `false` (never throws) on any fetch/parse failure for the policy
 * docs, matching resolveAiPolicyVerdict's own fail-open default for an absent/unreadable policy doc. When a
 * trigger fires, returns a trigger-specific reason string so callers can label audit-trail events accurately.
 */
export async function resolveRejectionSignaled(repoFullName: string, options: RejectionSignaledOptions = {}): Promise<false | RejectionSignaledReason | true> {
  const target = parseRepoFullName(repoFullName);
  if (!target) return false;
  const resolved = normalizeOptions(options);

  const aiUsage = await fetchPolicyDoc(target, "AI-USAGE.md", resolved);
  const contributing = aiUsage && aiUsage.trim() ? null : await fetchPolicyDoc(target, "CONTRIBUTING.md", resolved);

  const verdict = resolveAiPolicyVerdict({ aiUsage, contributing });
  // First trigger: an explicit live AI-usage-policy ban. A ban short-circuits -- no need to also check history.
  if (!verdict.allowed) return REJECTION_REASON_AI_USAGE_POLICY_BAN;
  // Second trigger (#5655): a prior submission from this same miner on this exact repo was closed/rejected.
  const ownHistoryRejected = await resolveOwnRejectionHistory(repoFullName, options);
  return ownHistoryRejected ? REJECTION_REASON_OWN_SUBMISSION_REJECTED : false;
}
