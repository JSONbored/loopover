// Duplication-REMOVAL delta analyzer (#4741, part of epic #4737). The sibling `duplication-scan.ts` analyzer
// (confirmed by reading it, not assumed — see its own header + this file's PR description) only detects NEW
// duplication a PR ADDS: a contiguous run of added lines that near-verbatim-matches something ALREADY elsewhere in
// the repo at headSha. It has no notion of a changed file's OWN pre-PR state, so it cannot see the complementary
// signal: a PR CONSOLIDATING duplication that already existed (two near-identical blocks reduced to one). This
// analyzer closes that gap using the shared `reconstructOldContent` primitive (#4739) to recover each changed
// file's pre-PR text, then reuses `duplication-scan.ts`'s OWN chunk-normalization + suffix-automaton
// longest-shared-run matcher (same `MIN_RUN`, same `normalizeLine`/block-splitting) so "what counts as a
// duplicate" is identical between the add-detector and this remove-detector — never a second, differently-tuned
// similarity algorithm running side by side with the first.
//
// Scope: PER FILE only. For each changed file, find pairs of near-identical blocks that existed in its
// RECONSTRUCTED OLD content, then assign each old block to an unclaimed matching NEW block via a maximum
// bipartite matching (#4812) over the old/new candidate graph — never a naive per-block "does this old block's
// text exist ANYWHERE in NEW" check, which would say BOTH old copies of a since-deduped block "survive" (the
// single remaining occurrence matches either query) and the resolved-duplication signal would never fire. The
// matching lets only as many old blocks "survive" as there are still-distinct matching occurrences in NEW; any
// old block left unmatched — but that WAS part of an old duplicate pair — is the resolved-duplication finding.
// Cross-file duplication removal (the twin lived in a DIFFERENT file, changed or not) is NOT detected —
// deliberately out of scope for this version (see PR description for the follow-up), not silently approximated.
//
// Fail-safe throughout: [] on missing token/headSha, a bad repo slug, an aborted signal, or when a file's content
// can't be fetched. `reconstructOldContent` returning either null (unreconstructable patch) or "" (file did not
// exist before this PR) means "no usable before-content" and is checked via plain truthiness — never `=== null` —
// so a wholly-added file is never mistreated as having pre-existing duplication to report on.
import type {
  AnalyzerDiagnostics,
  DuplicationDeltaFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchText } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";
import { reconstructOldContent } from "./reconstruct-old-content.js";
import { DEFAULT_MAX_FINDINGS } from "./limits.js";
import {
  isSourceExt,
  isExcludedPath,
  normalizeFileBlocks,
  buildMatchIndex,
  longestSharedRun,
  type NormBlock,
  type MatchIndex,
} from "./duplication-scan.js";

const GITHUB_API = "https://api.github.com";
// Requires an alphanumeric FIRST character (unlike a bare `[A-Za-z0-9._-]+`, which a segment of exactly ".." or
// "." would also satisfy — every char in ".." is individually allowed by that class). A leading-dot segment could
// let a URL parser's dot-segment resolution rewrite `/repos/../evil/contents/...` into an unintended path, sending
// the auth token somewhere other than the intended `owner/repo`. Mirrors codeowners.ts's stricter slug guard.
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_FILES = 20; // changed files probed per scan, mirroring doc-comment-drift's cap
const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const MAX_FETCH_BYTES = 1_000_000;
// Defensive cap on the O(blocks^2) internal self-pairing pass: a file with more significant-line blocks than this is
// skipped for the self-duplication check rather than risking pathological scan time on a huge/generated file.
const MAX_BLOCKS_PER_FILE = 150;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchText">;
  diagnostics?: AnalyzerDiagnostics;
}

interface InternalPair {
  /** Index into the OLD blocks array for each side of the pair (i < j, never equal). */
  i: number;
  j: number;
  /** 1-based OLD-content line where each side's matched run begins. */
  iLine: number;
  jLine: number;
  /** Contiguous significant lines that matched verbatim (whitespace-normalized). */
  length: number;
}

/** Fetch a changed file's raw content at `headSha` through the shared bounded-text helper (with the analysis
 *  context's caching/metering when supplied, mirroring `codeowners.ts`). Returns null on any non-OK / oversized /
 *  network outcome so the caller fails safe. */
async function fetchFileAtHead(
  owner: string,
  repo: string,
  path: string,
  headSha: string,
  token: string,
  fetchFn: typeof fetch,
  options: ScanOptions,
): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(headSha)}`;
  const fetchOptions = {
    endpointCategory: "github-contents",
    headers: githubHeaders(token, { raw: true }),
    signal: options.signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "duplicationDelta",
    subcall: "github-contents",
    maxBytes: MAX_FETCH_BYTES,
    maxCallsPerCategory: MAX_FILES,
  };
  const response = options.analysis
    ? await options.analysis.fetchText(url, fetchOptions)
    : await boundedFetchText(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Find every pair of DIFFERENT blocks in `blocks` sharing a contiguous run of >= MIN_RUN significant lines —
 *  i.e. content that was internally near-duplicated within this one file's OLD (pre-PR) state. Builds one
 *  suffix-automaton index per block and reuses it for every other block, the same indexing strategy
 *  `duplication-scan.ts` uses per candidate file. Bailing to [] on an aborted signal (mid-build or mid-match)
 *  discards any partial pairing rather than reporting it as complete. */
export function findInternalDuplicatePairs(
  blocks: NormBlock[],
  signal: AbortSignal | undefined,
): InternalPair[] {
  const pairs: InternalPair[] = [];
  if (blocks.length < 2 || blocks.length > MAX_BLOCKS_PER_FILE) return pairs;

  const indices = blocks.map((block) => buildMatchIndex(block, signal));
  for (let i = 0; i < blocks.length; i += 1) {
    if (signal?.aborted) return [];
    for (let j = i + 1; j < blocks.length; j += 1) {
      const index = indices[j];
      if (!index) continue; // index build was aborted for this candidate — no usable index
      const run = longestSharedRun(blocks[i]!, index, signal);
      if (run?.status === "aborted") return [];
      if (run?.status === "matched") {
        pairs.push({ i, j, iLine: run.headLine, jLine: run.sourceLine, length: run.length });
      }
    }
  }
  return pairs;
}

/** Assign each OLD block to an UNCLAIMED matching NEW block (>= MIN_RUN significant lines) via a true MAXIMUM
 *  bipartite matching — Kuhn's algorithm, an O(V*E) augmenting-path search over the old-block/new-index
 *  candidate graph — each NEW block usable by at most one OLD block. This is what lets duplicate COUNT
 *  reductions show up: if OLD had N near-identical copies of some text and NEW retains only M (M < N), exactly M
 *  of the N old blocks claim a surviving NEW occurrence and the remaining (N - M) do not — instead of every old
 *  copy independently matching the SAME still-present text and all appearing to "survive". Returns a parallel
 *  boolean array over `oldBlocks`.
 *
 *  A maximum matching (rather than a greedy, order-dependent one) is required because old-to-new candidacy can be
 *  asymmetric: if old block A matches BOTH of two remaining NEW occurrences but old block B matches only ONE of
 *  them, a first-come-first-claimed walk can let A grab the occurrence B needed, under-reporting a pair that is,
 *  in fact, still present (#4812, closing a known v1 heuristic gap). Kuhn's algorithm avoids this by re-routing
 *  an already-matched old block onto a different NEW occurrence it also fits, whenever doing so frees up an
 *  augmenting path for the old block currently being placed — so every old block that COULD be matched, IS
 *  matched.
 *
 *  Two-phase, so the abort-signal contract stays exactly what it was: phase 1 builds the full old×new adjacency
 *  matrix (the only part that calls `longestSharedRun`, i.e. the only part that can be slow or need aborting);
 *  phase 2 runs Kuhn's search purely over that already-known, in-memory boolean matrix (no further comparison
 *  work, so nothing left to abort). An aborted signal — checked before starting, and again before/after every
 *  `longestSharedRun` call in phase 1 — discards the whole in-progress matrix and returns all-`false` rather than
 *  run the matching over incomplete candidacy data, which could silently under-report a survivor exactly the way
 *  the old greedy version could. */
export function assignSurvivors(
  oldBlocks: NormBlock[],
  newIndices: MatchIndex[],
  signal: AbortSignal | undefined,
): boolean[] {
  const survived = new Array<boolean>(oldBlocks.length).fill(false);
  if (signal?.aborted) return survived;

  // Phase 1: the full candidacy matrix, `adjacency[i][n]` true iff old block i shares a >= MIN_RUN run with new
  // index n. Any abort here discards everything (returns all-`false`) — a partially built matrix under-counts
  // real edges, and matching over it would silently reintroduce the old greedy bug in a new shape.
  const adjacency: boolean[][] = [];
  for (let i = 0; i < oldBlocks.length; i += 1) {
    if (signal?.aborted) return survived;
    const row = new Array<boolean>(newIndices.length).fill(false);
    for (let n = 0; n < newIndices.length; n += 1) {
      if (signal?.aborted) return survived;
      const run = longestSharedRun(oldBlocks[i]!, newIndices[n]!, signal);
      if (run?.status === "aborted") return survived;
      if (run?.status === "matched") row[n] = true;
    }
    adjacency.push(row);
  }

  // Phase 2: Kuhn's algorithm. `matchOf[n]` is the OLD block index currently claiming NEW index `n` (-1 = free).
  // `visited` is scoped to one top-level old block's augmenting search so a NEW index already tried (and
  // rejected) THIS search is never revisited, but is fair game for the NEXT old block's own search.
  const matchOf = new Array<number>(newIndices.length).fill(-1);
  const tryAugment = (i: number, visited: boolean[]): boolean => {
    for (let n = 0; n < newIndices.length; n += 1) {
      if (!adjacency[i]![n] || visited[n]) continue;
      visited[n] = true;
      if (matchOf[n] === -1 || tryAugment(matchOf[n]!, visited)) {
        matchOf[n] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < oldBlocks.length; i += 1) {
    survived[i] = tryAugment(i, new Array<boolean>(newIndices.length).fill(false));
  }

  return survived;
}

/** Analyzer entrypoint: for each changed file, recover its pre-PR content and flag a duplicate block pair that
 *  existed before the change and is no longer both recognizable after — the reverse of what `duplication-scan.ts`
 *  can see (it only compares ADDED lines against the rest of the repo at head, never a file against its own
 *  past). Reports per-file/per-block deltas (never a bare total) so a downstream aggregator can consume
 *  structured findings. Fail-safe: [] on missing token/headSha, a bad repo slug, an aborted signal, or when a
 *  file's content can't be fetched or its old content can't be reconstructed. */
export async function scanDuplicationDelta(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DuplicationDeltaFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  if (options.signal?.aborted) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) {
    return [];
  }

  // Same file-eligibility filter as `duplication-scan.ts` (source-extension, not generated/vendored/minified/
  // declaration) so a file that could never produce an ADDED-duplication finding there is equally excluded here.
  const candidates = files
    .filter(
      (f) => f.status !== "removed" && !!f.patch && isSourceExt(f.path) && !isExcludedPath(f.path),
    )
    .slice(0, MAX_FILES);
  if (!candidates.length) return [];

  const findings: DuplicationDeltaFinding[] = [];

  for (const file of candidates) {
    if (options.signal?.aborted || findings.length >= MAX_FINDINGS) break;

    const headContent = await fetchFileAtHead(
      owner,
      repo,
      file.path,
      headSha,
      githubToken,
      fetchFn,
      options,
    );
    if (!headContent || options.signal?.aborted) continue;

    // Both null (unreconstructable patch) and "" (file did not exist before this PR) mean "no usable
    // before-content" — a plain truthiness check, never `=== null` (see reconstructOldContent's own contract).
    const oldContent = reconstructOldContent(headContent, file.patch!);
    if (!oldContent) continue;

    const oldBlocks = normalizeFileBlocks(oldContent);
    const pairs = findInternalDuplicatePairs(oldBlocks, options.signal);
    if (!pairs.length || options.signal?.aborted) continue;

    const newIndices = normalizeFileBlocks(headContent)
      .map((block) => buildMatchIndex(block, options.signal))
      .filter((index): index is MatchIndex => index !== null);

    const survived = assignSurvivors(oldBlocks, newIndices, options.signal);
    if (options.signal?.aborted) continue;

    // Each OLD block that took part in at least one duplicate pair and did NOT claim a surviving NEW block is
    // reported once — referencing the first pair partner encountered — even if it was part of several old
    // duplicate pairs (a block with 3+ near-identical old siblings never produces more than one finding for it).
    const reportedBlocks = new Set<number>();
    for (const pair of pairs) {
      if (findings.length >= MAX_FINDINGS) break;
      if (!survived[pair.i] && !reportedBlocks.has(pair.i)) {
        reportedBlocks.add(pair.i);
        findings.push({
          file: file.path,
          line: pair.iLine,
          duplicateOfLine: pair.jLine,
          lines: pair.length,
        });
      }
      if (findings.length >= MAX_FINDINGS) break;
      if (!survived[pair.j] && !reportedBlocks.has(pair.j)) {
        reportedBlocks.add(pair.j);
        findings.push({
          file: file.path,
          line: pair.jLine,
          duplicateOfLine: pair.iLine,
          lines: pair.length,
        });
      }
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}
