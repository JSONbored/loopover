// Convergence (RAG retrieval) wiring: feeds the AI reviewer the most RELEVANT EXISTING code/docs from the
// repository's CURRENT tree (callers, related modules, existing conventions) that the diff alone doesn't show,
// so a non-frontier model judges the change against how the rest of the codebase actually works. This is the
// RETRIEVAL half of codebase RAG (Layer C) — additive prompt context, exactly like `grounding-wire`.
//
// Single env switch: GITTENSORY_REVIEW_RAG. Default OFF (unset/"false") — when OFF this module is never invoked from
// the review path (the caller guards on the flag), gathers nothing, makes NO adapter use and NO vector query,
// and the reviewer prompt is byte-identical to today. Truthy follows the codebase convention
// (`/^(1|true|yes|on)$/i`, same as isGroundingEnabled / isSafetyEnabled / isEnabled).
//
// The ported, self-contained retrieval engine lives in `./rag` (`retrieveContext`, fully fail-safe); this file
// is the thin HOST adapter that (1) builds the injected infra via `createReviewAdapters(env)` (which degrades a
// missing Vectorize/AI binding to an unavailable adapter), (2) composes the query text from the PR's changed
// files + diff, and (3) returns the retrieved block to splice into the user prompt. Fully fail-safe: a missing
// Vectorize/AI binding, an empty/cold index, or ANY error degrades to "" (no context) and the review proceeds on
// the diff. This module NEVER throws.
//
// Index POPULATION (ingesting a repo's code so `retrieveContext` has something to return) is implemented in
// `./rag-index.ts` and scheduled from the cron + merged-PR webhooks; this module wires RETRIEVAL only. With the
// flag ON but a cold/empty index, `retrieveContext` returns "" — the capability activates once an index exists.

import { createReviewAdapters } from "./adapters";
import { type RagChunk, retrieveContext, upsertChunks } from "./rag";

/** True when RAG retrieval is enabled. Flag-OFF (default) → the caller takes no new branch, so no retrieval is
 *  performed and the reviewer prompt is unchanged. */
export function isRagEnabled(env: { GITTENSORY_REVIEW_RAG?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_RAG ?? "");
}

/** Cap on how many changed-file paths feed the query string — bounds the query length / embed cost. */
const MAX_QUERY_PATHS = 40;
/** Cap on how much of the diff feeds the query (the embedder truncates anyway; keep the query focused). */
const MAX_QUERY_DIFF_CHARS = 4000;
/** Default neighbours retrieved per review (rag.ts hard-caps at RAG_MAX_TOPK regardless). */
const RAG_TOP_K = 12;
/** Relevance floor for the cosine matches — drops low-relevance "neighbours" that are noise, not real context
 *  (bge-m3 scores relevant code ~0.5-0.7 and clear noise <0.35; 0.4 is a conservative floor). Matches reviewbot's
 *  core config (`rag: { minScore: 0.4 }`); gittensory previously used 0 (off), which kept that noise as
 *  "relevant code" and itself drove false positives. (#GAP-2) */
const RAG_MIN_SCORE = 0.4;
/** Rerank the cosine top-K by exact-term overlap before injecting, to demote vector-accident matches (high
 *  cosine, no real term overlap). Matches reviewbot's core config (`rag: { reranker: "bm25" }`); gittensory
 *  previously left this off. (#283 / #GAP-2) */
const RAG_RERANKER = "bm25" as const;

/** The subset of a PR file record the query builder reads (filename + the patch text when present). */
export type RagQueryFile = { path: string; patch?: string | undefined };

/**
 * Compose the retrieval QUERY TEXT from the PR's TITLE + changed files. We PREPEND the PR title (intent in natural
 * language — recall parity with reviewbot, whose query is `${title}\n${diff}`), then embed the changed PATHS plus a
 * bounded slice of the diff so the vector query finds code semantically near both WHY the PR exists and WHAT
 * CHANGED (callers/related modules). The changed paths are ALSO returned as `excludePaths` so retrieval never
 * echoes a file that is itself part of the diff (that's already in the prompt). Returns "" when there's nothing to
 * query on (no files).
 */
export function buildRagQuery(files: RagQueryFile[], title?: string): { queryText: string; excludePaths: string[] } {
  const paths = files.map((f) => f.path).filter(Boolean);
  const excludePaths = [...new Set(paths)];
  if (excludePaths.length === 0) return { queryText: "", excludePaths };
  const pathList = excludePaths.slice(0, MAX_QUERY_PATHS).join("\n");
  // A bounded sample of the patches gives the embedder real tokens to match on (identifiers, API names) rather
  // than only filenames — better recall for "what existing code is related to this change".
  let diffSample = "";
  for (const file of files) {
    if (diffSample.length >= MAX_QUERY_DIFF_CHARS) break;
    const patch = typeof file.patch === "string" ? file.patch : "";
    if (patch) diffSample += `${patch}\n`;
  }
  // Prepend the PR title so the embedder sees the change's intent in plain language (recall parity with reviewbot).
  const titleLine = typeof title === "string" && title.trim() ? `${title.trim()}\n\n` : "";
  const queryText = `${titleLine}Changed files:\n${pathList}\n\n${diffSample}`.slice(0, MAX_QUERY_DIFF_CHARS + 2000).trim();
  return { queryText, excludePaths };
}

/**
 * Build the RAG context block to splice into the AI reviewer's USER prompt (flag-gated by the CALLER, fail-safe).
 * Builds the injected infra from `env` (a missing Vectorize/AI binding ⇒ no vector/inference adapter ⇒ retrieval
 * returns ""), composes the query from the changed files, and runs `retrieveContext`. Returns "" — and the prompt
 * stays byte-identical — whenever there's nothing to query, the index is cold/missing, or anything errors. This
 * NEVER throws.
 *
 * `retrieveContext` returns its own pre-formatted, self-labelled block ("RELEVANT EXISTING CODE / DOCS …"); we
 * return it verbatim so the reviewer sees the same fenced reference section the engine produced.
 */
export async function buildReviewRagContext(
  env: Env,
  args: { repoFullName: string; files: RagQueryFile[]; title?: string; reranker?: "off" | "bm25" },
): Promise<string> {
  try {
    const { queryText, excludePaths } = buildRagQuery(args.files, args.title);
    if (!queryText) return "";
    const infra = createReviewAdapters(env);
    // No vector index or no AI binding → the adapters omit the member and retrieveContext returns "" (no RAG).
    if (!infra.vector || !infra.inference) return "";
    const [project, repo] = splitRepo(args.repoFullName);
    // Quality knobs match reviewbot's core config: drop low-relevance cosine matches (minScore) and BM25-rerank the
    // survivors (reranker) so only genuinely-related code reaches the prompt — low-relevance "neighbours" are noise
    // that themselves cause false positives. A caller-supplied reranker still wins (e.g. to force "off"). (#GAP-2)
    return await retrieveContext(infra, {
      project,
      repo,
      queryText,
      topK: RAG_TOP_K,
      excludePaths,
      minScore: RAG_MIN_SCORE,
      reranker: args.reranker ?? RAG_RERANKER,
    });
  } catch {
    return ""; // any error → review proceeds on the diff alone (fail-safe)
  }
}

/** Split `owner/name` into the (project, repo) pair RAG namespaces on. A name with no slash is treated as the
 *  repo with an empty project; both halves are passed to `ragNamespace` which lowercases + bounds them. */
function splitRepo(repoFullName: string): [string, string] {
  const slash = repoFullName.indexOf("/");
  return slash === -1 ? ["", repoFullName] : [repoFullName.slice(0, slash), repoFullName.slice(slash + 1)];
}

// Index POPULATION (fetch repo tree → `chunkFile` → `embedTexts` → `upsertChunks`, plus incremental re-index on
// push via `deleteChunksForPaths` + `upsertChunks`) is implemented in `./rag-index.ts` and scheduled from the
// six-hourly cron fan-out + on merged-PR webhooks. This module wires RETRIEVAL only.
