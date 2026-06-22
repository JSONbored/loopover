// Convergence (RAG retrieval) wiring: feeds the AI reviewer the most RELEVANT EXISTING code/docs from the
// repository's CURRENT tree (callers, related modules, existing conventions) that the diff alone doesn't show,
// so a non-frontier model judges the change against how the rest of the codebase actually works. This is the
// RETRIEVAL half of codebase RAG (Layer C) — additive prompt context, exactly like `grounding-wire`.
//
// Single env switch: REVIEWBOT_RAG. Default OFF (unset/"false") — when OFF this module is never invoked from
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
// DEFERRED — the INDEX-POPULATION job + cron (OUT OF SCOPE for this chunk). Retrieval is inert until an index
// exists: a real Vectorize resource must be provisioned AND a repo's CODE must be ingested (fetch tree → chunk
// via `chunkFile` → embed via `embedTexts` → `upsertChunks` to Vectorize + the `repo_chunks` table), then kept
// fresh on push (incremental re-index via `deleteChunksForPaths` + `upsertChunks`) on a cron. That job is a
// DEPLOY-TIME / ops concern (it needs the live Vectorize binding + the queue + the `repo_chunks` migration) and
// is tracked here as `INDEX_JOB_FOLLOWUP` / the `populateRepoIndexStub` documented stub below. Until it runs,
// `retrieveContext` sees a cold namespace and returns "" — the capability activates once an index exists AND the
// flag is ON (exactly as grounding activates once data is attached).

import { createReviewAdapters } from "./adapters";
import { type RagChunk, retrieveContext, upsertChunks } from "./rag";

/** True when RAG retrieval is enabled. Flag-OFF (default) → the caller takes no new branch, so no retrieval is
 *  performed and the reviewer prompt is unchanged. */
export function isRagEnabled(env: { REVIEWBOT_RAG?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.REVIEWBOT_RAG ?? "");
}

/** Cap on how many changed-file paths feed the query string — bounds the query length / embed cost. */
const MAX_QUERY_PATHS = 40;
/** Cap on how much of the diff feeds the query (the embedder truncates anyway; keep the query focused). */
const MAX_QUERY_DIFF_CHARS = 4000;
/** Default neighbours retrieved per review (rag.ts hard-caps at RAG_MAX_TOPK regardless). */
const RAG_TOP_K = 12;

/** The subset of a PR file record the query builder reads (filename + the patch text when present). */
export type RagQueryFile = { path: string; patch?: string | undefined };

/**
 * Compose the retrieval QUERY TEXT from the PR's changed files. We embed the changed PATHS plus a bounded slice
 * of the diff so the vector query finds code semantically near WHAT CHANGED (callers/related modules), not just
 * the PR title. The changed paths are ALSO returned as `excludePaths` so retrieval never echoes a file that is
 * itself part of the diff (that's already in the prompt). Returns "" when there's nothing to query on.
 */
export function buildRagQuery(files: RagQueryFile[]): { queryText: string; excludePaths: string[] } {
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
  const queryText = `Changed files:\n${pathList}\n\n${diffSample}`.slice(0, MAX_QUERY_DIFF_CHARS + 2000).trim();
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
  args: { repoFullName: string; files: RagQueryFile[]; reranker?: "off" | "bm25" },
): Promise<string> {
  try {
    const { queryText, excludePaths } = buildRagQuery(args.files);
    if (!queryText) return "";
    const infra = createReviewAdapters(env);
    // No vector index or no AI binding → the adapters omit the member and retrieveContext returns "" (no RAG).
    if (!infra.vector || !infra.inference) return "";
    const [project, repo] = splitRepo(args.repoFullName);
    return await retrieveContext(infra, {
      project,
      repo,
      queryText,
      topK: RAG_TOP_K,
      excludePaths,
      ...(args.reranker ? { reranker: args.reranker } : {}),
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

// ── DEFERRED: the index-population job + cron (documented stub) ────────────────────────────────────
//
// This chunk wires RETRIEVAL only. Populating + maintaining the index is a separate DEPLOY-TIME / ops sub-task
// because it needs (a) a real Vectorize resource provisioned, (b) the `repo_chunks` storage table + migration,
// and (c) a queue/cron consumer that fetches a repo's tree, chunks the code, embeds it, and upserts. The pure
// chunk→embed→upsert primitives ALREADY EXIST and are fail-safe (`chunkFile`, `embedTexts`, `upsertChunks`,
// `deleteChunksForPaths` in `./rag`); the missing piece is only the ingestion driver + its schedule.
//
// FOLLOW-UP ticket marker (searchable):
export const INDEX_JOB_FOLLOWUP =
  "convergence-followup: build the RAG index-population job (fetch repo tree → chunkFile → embedTexts → " +
  "upsertChunks to Vectorize + repo_chunks) + a cron/push trigger for incremental re-index (deleteChunksForPaths " +
  "+ upsertChunks). Needs the live Vectorize binding + the repo_chunks migration. Retrieval is inert until this runs.";

/**
 * Documented STUB for the deferred index-population job. It deliberately performs NO repo fetch / chunking /
 * scheduling — that driver + its migration + cron are the follow-up tracked by {@link INDEX_JOB_FOLLOWUP}.
 * The single line it does have proves the wiring shape end-to-end: given already-chunked files, it delegates to
 * the fail-safe `upsertChunks` (which no-ops to 0 when Vectorize/AI is absent). The real job will produce those
 * `RagChunk[]` from a repo tree via `chunkFile` and run on a cron/push trigger.
 *
 * @returns the number of chunks upserted (0 when the index/infra is unavailable — fail-safe, never throws).
 */
export async function populateRepoIndexStub(env: Env, repoFullName: string, chunks: RagChunk[]): Promise<number> {
  const infra = createReviewAdapters(env);
  const [project, repo] = splitRepo(repoFullName);
  return upsertChunks(infra, project, repo, chunks);
}
