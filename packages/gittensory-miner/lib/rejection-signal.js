import { resolveAiPolicyVerdict } from "@jsonbored/gittensory-engine";

// Real rejectionSignaled resolver (#5132, Wave 3.5 follow-up). iterate-policy.ts's own doc comment: "True
// when the target repo (or this contributor's history with it) has signaled it does not want automated/
// AI-authored contributions -- an explicit AI-usage-policy ban, or a prior submission from this same miner
// was closed/rejected on this exact repo. The caller resolves this ... and passes it in; this policy does
// not compute it itself." This module resolves the FIRST trigger: a real AI-USAGE.md/CONTRIBUTING.md ban,
// fetched live and scanned via the engine's own resolveAiPolicyVerdict -- the same check
// opportunity-fanout.js already runs during discovery, applied here at attempt time instead.
//
// The SECOND trigger (a prior submission from this same miner was closed/rejected on this exact repo) is
// DELIBERATELY not resolved here: it would need each of this miner's recorded own-submissions
// (governor-state.js's listRecentOwnSubmissions, #5134) checked against its live PR outcome via
// rejection-state-machine.js's resolveRejection -- a second, separately-scoped fetch-and-classify pipeline.
// Not fabricated as "no rejection history" -- explicitly left as a known, documented gap for a follow-up,
// same discipline as SelfReviewContext's bounties/issueQuality (#5145) and this file's own callers should
// not assume a false result here means "no rejection signal of any kind."

const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const MAX_POLICY_DOC_BYTES = 128 * 1024;

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
}

function normalizeOptions(options = {}) {
  return {
    rawContentBaseUrl:
      typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

async function readBoundedPolicyDoc(response) {
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
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_POLICY_DOC_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchPolicyDoc(target, path, resolved) {
  const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
  try {
    const response = await resolved.fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "loopover-miner" } });
    if (!response.ok) return null;
    return await readBoundedPolicyDoc(response);
  } catch {
    return null;
  }
}

/**
 * Resolve whether the target repo has an explicit, live AI-usage-policy ban -- the first of
 * `rejectionSignaled`'s two documented triggers. Returns `false` (never throws) on any fetch/parse failure,
 * matching resolveAiPolicyVerdict's own fail-open default for an absent/unreadable policy doc.
 *
 * @param {string} repoFullName
 * @param {{ rawContentBaseUrl?: string, fetchImpl?: import("./self-review-context.js").SelfReviewContextFetch }} [options]
 * @returns {Promise<boolean>}
 */
export async function resolveRejectionSignaled(repoFullName, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (!target) return false;
  const resolved = normalizeOptions(options);

  const aiUsage = await fetchPolicyDoc(target, "AI-USAGE.md", resolved);
  const contributing = aiUsage && aiUsage.trim() ? null : await fetchPolicyDoc(target, "CONTRIBUTING.md", resolved);

  const verdict = resolveAiPolicyVerdict({ aiUsage, contributing });
  return !verdict.allowed;
}
