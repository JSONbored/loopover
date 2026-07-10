// Hosted `gittensory_retrieve_issue_context` (#4293): metadata-only issue-centric RAG retrieval for the
// miner analyze phase. Composes `buildIssueRagQuery` and runs `retrieveContextWithMetrics` server-side
// via a hosted API round-trip (stdio MCP proxies to `/v1/issue-rag/retrieve`). Returns retrieved paths
// and scores only — never chunk bodies or source text.

import { buildIssueRagQuery } from "../../packages/gittensory-engine/src/issue-rag-query";
import { PREFLIGHT_LIMITS } from "../signals/preflight-limits";
import { emptyIssueRagTelemetry, normalizeIssueRagTopK, retrieveIssueRagContext, type IssueRagTelemetry } from "../review/issue-rag-retrieval";

export const MAX_ISSUE_RAG_OWNER_LENGTH = 39;
export const MAX_ISSUE_RAG_REPO_LENGTH = 100;

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

function cleanLabels(labels: string[] | undefined): string[] | undefined {
  if (!labels) return undefined;
  const cleaned = labels.map((label) => label.trim()).filter(Boolean).slice(0, PREFLIGHT_LIMITS.labels);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function validateIssueRagInput(
  input: IssueRagInput,
): { ok: true; value: IssueRagInput & { repoFullName: string } } | { ok: false; reason: string } {
  const owner = typeof input.owner === "string" ? input.owner.trim() : "";
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!owner || !repo) return { ok: false, reason: "owner_and_repo_required" };
  if (!title) return { ok: false, reason: "title_required" };
  if (owner.length > MAX_ISSUE_RAG_OWNER_LENGTH) return { ok: false, reason: "owner_too_long" };
  if (repo.length > MAX_ISSUE_RAG_REPO_LENGTH) return { ok: false, reason: "repo_too_long" };
  if (title.length > PREFLIGHT_LIMITS.titleChars) return { ok: false, reason: "title_too_long" };
  const body = typeof input.body === "string" ? input.body.slice(0, PREFLIGHT_LIMITS.bodyChars) : undefined;
  const labels = cleanLabels(input.labels);
  if (labels) {
    for (const label of labels) {
      if (label.length > PREFLIGHT_LIMITS.labelChars) return { ok: false, reason: "invalid_labels" };
    }
  }
  const topK = input.topK;
  if (topK !== undefined && (!Number.isFinite(topK) || topK < 1 || topK > 12)) {
    return { ok: false, reason: "invalid_top_k" };
  }
  return {
    ok: true,
    value: {
      owner,
      repo,
      title,
      ...(body !== undefined ? { body } : {}),
      ...(labels ? { labels } : {}),
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
