// Deterministic impact-map computation (#2183, compute slice of #1971). Given the changed symbols (#2182's
// extractChangedSymbols output) and the existing RAG index, resolve — per changed file — the OTHER files in
// the repo that plausibly need re-checking (likely callers / related modules). This is "impact map" as in
// "files a maintainer should also glance at", not a guaranteed-complete call graph: it is built entirely from
// the RAG vector index's existing retrieval (`retrieveContextWithMetrics`), reusing its retrieved-path
// ordering rather than inventing a new ranking. No AI judgment; a pure, bounded, fail-safe wrapper over
// retrieval already used elsewhere in the review pipeline.
//
// FAIL-SAFE (mirrors rag.ts's own guarantee): a missing/cold RAG index, no changed symbols, or any retrieval
// error degrades to an EMPTY impact map — this computation can never break or block a review.

import type { FileChangedSymbols } from "./impact-symbols";
import { retrieveContextWithMetrics, type RagInfra } from "./rag";

export type ImpactMapEntry = {
  /** The file whose changed exported symbol(s) triggered this entry. */
  changedModule: string;
  /** Other repo files the RAG index surfaced as semantically related to the changed symbol(s) — the "files
   *  that plausibly need re-checking" set. Excludes the changed module itself. Deterministically ordered
   *  (RAG's own cosine/BM25 rerank order) and capped at MAX_AFFECTED_MODULES. */
  affectedModules: string[];
  /** The changed symbol names that drove this entry's query — surfaced so a renderer can explain WHY a
   *  module is listed (e.g. "computeImpactMap, extractChangedSymbols"). */
  callers: string[];
};

/** Hard cap on affected modules surfaced per changed module — bounds both the RAG query cost (already capped
 *  by rag.ts's RAG_MAX_TOPK) and the rendered/prompt size downstream (#2185/#2186 both need a small, stable
 *  list, not a sprawling one). */
export const MAX_AFFECTED_MODULES_PER_ENTRY = 8;

/** Hard cap on how many changed-symbol files computeImpactMap will issue a RAG query for. Without this, the
 *  number of vector queries scales directly with the (contributor-controlled) changed-file count — a PR
 *  touching hundreds of files would issue hundreds of retrieveContextWithMetrics calls with no bound.
 *  Matches boundary-test-generation.ts's MAX_TOUCHES precedent for the same "bound a per-changed-file loop"
 *  concern. Input order is preserved (deterministic ordering doc above), so this simply stops processing
 *  after the first N symbol-bearing files rather than sampling. */
export const MAX_IMPACT_MAP_INPUT_FILES = 20;

/** How many neighbours to request per changed-module query. Kept modest (< RAG's own RAG_MAX_TOPK=20) since
 *  we only keep MAX_AFFECTED_MODULES_PER_ENTRY of them anyway. */
const IMPACT_MAP_TOP_K = 12;

/** Relevance floor for impact-map neighbours — mirrors rag-wire.ts's RAG_MIN_SCORE (0.4): a low-cosine
 *  "neighbour" is noise for a reviewer, not a real caller/related-module hint. */
const IMPACT_MAP_MIN_SCORE = 0.4;

/** Compose the per-file RAG query text from its changed symbol names. Only called for a file that already has
 *  at least one extracted symbol (the caller filters out symbol-less files first), so the composed text is
 *  always non-empty: the symbol names plus the file path give the embedder real tokens to match on rather
 *  than only a filename. */
function buildSymbolQueryText(file: FileChangedSymbols): string {
  return `Changed symbols: ${file.symbols.join(", ")}\nFile: ${file.path}`;
}

/**
 * Compute the deterministic impact map for a PR's changed symbols. One entry per changed file that has at
 * least one extracted symbol (files with none contribute no entry — there's nothing symbol-driven to query
 * on) and whose RAG query surfaces at least one affected module. Deterministic ordering: entries follow the
 * INPUT file order; each entry's `affectedModules` follows RAG's own retrieval order (cosine + optional BM25
 * rerank, both already deterministic). Fail-safe: no vector/inference adapter, a cold/empty index, or any
 * retrieval error yields an EMPTY impact map, never a throw.
 */
export async function computeImpactMap(
  symbols: FileChangedSymbols[],
  ragContext: { infra: RagInfra; project: string; repo: string },
): Promise<ImpactMapEntry[]> {
  const out: ImpactMapEntry[] = [];
  // Symbol-less files never query (nothing to look up) and so never count against the cap below -- filter
  // them out first so the cap applies to the actual query budget, not a raw slice of the input.
  const queryableFiles = symbols.filter((file) => file.symbols.length > 0).slice(0, MAX_IMPACT_MAP_INPUT_FILES);
  for (const file of queryableFiles) {
    const queryText = buildSymbolQueryText(file);
    let affectedModules: string[];
    try {
      const result = await retrieveContextWithMetrics(ragContext.infra, {
        project: ragContext.project,
        repo: ragContext.repo,
        queryText,
        topK: IMPACT_MAP_TOP_K,
        minScore: IMPACT_MAP_MIN_SCORE,
        excludePaths: [file.path],
        reranker: "bm25",
      });
      affectedModules = result.metrics.paths.slice(0, MAX_AFFECTED_MODULES_PER_ENTRY);
      // Defense in depth: retrieveContextWithMetrics is itself fail-safe (its own try/catch degrades a
      // throwing vector/inference adapter to an empty result internally — never throws out to us), but this
      // computation must never be the reason a review pass fails, so keep the belt-and-braces catch below —
      // it degrades this ONE file's entry to "no affected modules" rather than failing the whole impact map.
      /* v8 ignore start */
    } catch {
      affectedModules = [];
    }
    /* v8 ignore stop */
    if (affectedModules.length === 0) continue;
    out.push({ changedModule: file.path, affectedModules, callers: [...file.symbols] });
  }
  return out;
}
