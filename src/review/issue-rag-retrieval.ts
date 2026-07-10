// Issue-centric RAG retrieval wiring (#4293): composes `buildIssueRagQuery` and runs the hosted
// Vectorize/D1 retrieval backend (`retrieveContextWithMetrics` in `./rag`). Fail-safe — a missing
// binding, cold index, short query, or any error degrades to empty metadata and NEVER throws.
// The MCP/API surfaces return metadata only (paths + scores), never retrieved source text.

import { buildIssueRagQuery } from "../../packages/gittensory-engine/src/issue-rag-query";
import { createReviewAdapters } from "./adapters";
import { retrieveContextWithMetrics } from "./rag";

const RAG_TOP_K = 12;
const RAG_MIN_SCORE = 0.4;
const RAG_RERANKER = "bm25" as const;
const MAX_ISSUE_RAG_TOP_K = 12;

export type IssueRagTelemetry = {
  attempted: boolean;
  injected: boolean;
  candidates: number;
  kept: number;
  topScore: number;
  minScore: number;
  reranked: boolean;
  injectedChars: number;
  retrievedPathCount: number;
  retrievedPaths: string[];
};

export type IssueRagRetrievalResult = {
  repoFullName: string;
  telemetry: IssueRagTelemetry;
};

export function emptyIssueRagTelemetry(): IssueRagTelemetry {
  return {
    attempted: false,
    injected: false,
    candidates: 0,
    kept: 0,
    topScore: 0,
    minScore: 0,
    reranked: false,
    injectedChars: 0,
    retrievedPathCount: 0,
    retrievedPaths: [],
  };
}

function splitRepo(repoFullName: string): [string, string] {
  const slash = repoFullName.indexOf("/");
  return slash === -1 ? ["", repoFullName] : [repoFullName.slice(0, slash), repoFullName.slice(slash + 1)];
}

export function normalizeIssueRagTopK(topK: number | null | undefined): number {
  if (!Number.isFinite(topK)) return RAG_TOP_K;
  return Math.min(MAX_ISSUE_RAG_TOP_K, Math.max(1, Math.trunc(topK!)));
}

/**
 * Run issue-centric RAG retrieval for the miner analyze phase. Returns metadata-only telemetry
 * (retrieved paths + scores) — never the retrieved chunk bodies. Degrades to empty telemetry when
 * the query is too short, the backend is unavailable, or anything errors.
 */
export async function retrieveIssueRagContext(
  env: Env,
  args: {
    repoFullName: string;
    title: string;
    body?: string | undefined;
    labels?: string[] | undefined;
    topK?: number | undefined;
    reranker?: "off" | "bm25" | undefined;
  },
): Promise<IssueRagRetrievalResult> {
  const repoFullName = args.repoFullName.trim();
  try {
    const { queryText } = buildIssueRagQuery({
      title: args.title,
      body: args.body,
      labels: args.labels,
    });
    if (!queryText) {
      return { repoFullName, telemetry: emptyIssueRagTelemetry() };
    }
    const infra = createReviewAdapters(env);
    if (!infra.vector || !infra.inference) {
      return { repoFullName, telemetry: emptyIssueRagTelemetry() };
    }
    const [project, repo] = splitRepo(repoFullName);
    const result = await retrieveContextWithMetrics(infra, {
      project,
      repo,
      queryText,
      topK: normalizeIssueRagTopK(args.topK),
      minScore: RAG_MIN_SCORE,
      reranker: args.reranker ?? RAG_RERANKER,
    });
    return {
      repoFullName,
      telemetry: {
        attempted: true,
        injected: result.metrics.paths.length > 0,
        candidates: result.metrics.candidates,
        kept: result.metrics.kept,
        topScore: result.metrics.topScore,
        minScore: result.metrics.minScore,
        reranked: result.metrics.reranked,
        injectedChars: result.metrics.injectedChars,
        retrievedPathCount: result.metrics.paths.length,
        retrievedPaths: result.metrics.paths,
      },
    };
  } catch {
    return { repoFullName, telemetry: emptyIssueRagTelemetry() };
  }
}
