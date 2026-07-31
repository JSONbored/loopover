// Hosted `loopover_retrieve_issue_context` (#4293): metadata-only issue-centric RAG retrieval for the
// miner analyze phase. Composes `buildIssueRagQuery` and runs `retrieveContextWithMetrics` server-side
// via a hosted API round-trip (stdio MCP proxies to `/v1/issue-rag/retrieve`). Returns retrieved paths
// and scores only — never chunk bodies or source text.

import { buildIssueRagQuery } from "../../packages/loopover-engine/src/issue-rag-query";
import { PREFLIGHT_LIMITS } from "../signals/preflight-limits";
import { emptyIssueRagTelemetry, normalizeIssueRagTopK, retrieveIssueRagContext, type IssueRagTelemetry } from "../review/issue-rag-retrieval";

export type IssueRagInput = {
  owner: string;
  repo: string;
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  topK?: number | undefined;
};

export type IssueRagResult = {
  status: "ok" | "invalid_request" | "query_too_short";
  repoFullName: string;
  reason?: string | undefined;
  telemetry: IssueRagTelemetry;
};

function cleanLabels(labels: string[] | undefined): { ok: true; value: string[] | undefined } | { ok: false; reason: string } {
  if (!labels) return { ok: true, value: undefined };
  // #10040: do not silently truncate — over-long arrays are rejected by RetrieveIssueContextInput
  // before this runs; here we only trim/filter empties and enforce per-label length after trim.
  const cleaned: string[] = [];
  for (const label of labels) {
    const value = label.trim();
    if (!value) continue;
    if (value.length > PREFLIGHT_LIMITS.labelChars) return { ok: false, reason: "invalid_labels" };
    cleaned.push(value);
  }
  return { ok: true, value: cleaned.length > 0 ? cleaned : undefined };
}

export function validateIssueRagInput(
  input: IssueRagInput,
): { ok: true; value: IssueRagInput & { repoFullName: string } } | { ok: false; reason: string } {
  // #10040: bound/type checks live on RetrieveIssueContextInput. This helper keeps trimming and the
  // post-trim emptiness checks zod cannot see (whitespace-only owner/repo/title), and refuses
  // over-long body instead of slicing it.
  const owner = typeof input.owner === "string" ? input.owner.trim() : "";
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!owner || !repo) return { ok: false, reason: "owner_and_repo_required" };
  if (!title) return { ok: false, reason: "title_required" };
  if (typeof input.body === "string" && input.body.length > PREFLIGHT_LIMITS.bodyChars) {
    return { ok: false, reason: "body_too_long" };
  }
  const body = typeof input.body === "string" ? input.body : undefined;
  const labelsResult = cleanLabels(input.labels);
  if (!labelsResult.ok) return labelsResult;
  const topK = input.topK;
  if (topK !== undefined && (!Number.isFinite(topK) || topK < 1 || topK > 12 || !Number.isInteger(topK))) {
    return { ok: false, reason: "invalid_top_k" };
  }
  return {
    ok: true,
    value: {
      owner,
      repo,
      title,
      ...(body !== undefined ? { body } : {}),
      ...(labelsResult.value ? { labels: labelsResult.value } : {}),
      ...(topK !== undefined ? { topK: normalizeIssueRagTopK(topK) } : {}),
      repoFullName: `${owner}/${repo}`,
    },
  };
}

export async function runIssueRagRetrieval(env: Env, input: IssueRagInput): Promise<IssueRagResult> {
  const validated = validateIssueRagInput(input);
  if (!validated.ok) {
    return {
      status: "invalid_request",
      repoFullName: "",
      reason: validated.reason,
      telemetry: emptyIssueRagTelemetry(),
    };
  }
  const { queryText } = buildIssueRagQuery({
    title: validated.value.title,
    body: validated.value.body,
    labels: validated.value.labels,
  });
  if (!queryText) {
    return {
      status: "query_too_short",
      repoFullName: validated.value.repoFullName,
      reason: "issue_query_below_retrieval_floor",
      telemetry: emptyIssueRagTelemetry(),
    };
  }
  const retrieved = await retrieveIssueRagContext(env, {
    repoFullName: validated.value.repoFullName,
    title: validated.value.title,
    body: validated.value.body,
    labels: validated.value.labels,
    topK: validated.value.topK,
  });
  return {
    status: "ok",
    repoFullName: retrieved.repoFullName,
    telemetry: retrieved.telemetry,
  };
}
