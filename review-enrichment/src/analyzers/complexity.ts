// Approximate cyclomatic-complexity analyzer (#1477). The `complexity` AnalyzerName this file registers looks
// only at diff hunks -- so it is deliberately NOT a whole-function true McCabe count (that needs a real parser
// reading the ENTIRE function, including any part outside the diff). Instead it approximates: for each newly-added
// function whose OPENING line is visible in the diff (named `function` declarations and arrow functions assigned
// to const/let/var -- the same structural detection size-smell.ts (#2019) already uses for "big-function"), it
// counts branch/loop/logical-operator tokens across the function's ADDED body lines only and reports
// `1 + that count`, the standard McCabe formula computed on the visible slice. A function whose signature line is
// NOT part of the diff (only its body was edited) is not attributed a score by THIS analyzer -- see
// complexity-delta.ts (#4740, part of epic #4737) for the sibling analyzer that covers exactly that case: using
// the shared reconstructOldContent primitive (#4739) to recover the pre-PR file text, it re-runs this file's OWN
// decision-point counting (via `scanContentForComplexity` below, reused unchanged) against both the reconstructed
// old and current head versions of a file and diffs the two per function.
//
// complexity-delta is a SEPARATE AnalyzerName, not a change to this one's `run`/`cost`/`requires` -- merging its
// network-dependent fetch into this entry's single `requires`/`cost` would either (a) gate this free, local,
// always-on absolute-threshold check behind `github-token`/`head-sha`, regressing it whenever either is
// unavailable (scheduler.ts's skipReasonForAnalyzer skips a descriptor's `run` entirely based on its DECLARED
// `requires`, before `run` is ever invoked -- see brief.ts/scheduler.ts), or (b) mislabel the network-dependent
// half as `cost: "local"`, letting it dodge the `github-light` concurrency/timeout budget it honestly consumes
// and silently including it in the `fast` profile, which is meant to stay network-free. Two honestly-classified
// descriptors instead of one dishonest one; `scanContentForComplexity` is what lets both share one counting
// implementation rather than duplicating it.
//
// Distinct from deep-nesting.ts (#2030), which measures brace NESTING depth -- a readability smell that
// analyzer's own header explicitly disclaims as a complexity metric. This analyzer counts DECISION POINTS
// instead: a flat function (nesting depth 1) can still have high complexity from many sibling `if`/`&&` checks,
// and a deeply-nested function can have low complexity if each level has only one predicate. The two analyzers
// intentionally measure different axes of the same diff.
//
// Ternary (`? :`) is deliberately EXCLUDED from the decision-point count: distinguishing a conditional
// expression's `?` from TypeScript's optional-property/parameter marker (`foo?: T`) or optional chaining
// (`?.`) is not reliably decidable per-line by regex without a false-positive rate this precision-first
// heuristic rejects. if/for/while/case/catch/&&/||/?? are unambiguous token shapes that cover the bulk of
// realistic branching.
//
// Pure compute, no network, no new dependency for THIS file's `complexity` `run`. churn-hotspot (#1513) is not
// precedent for a broader one-time fetch here either: it fetches commit METADATA that cannot exist in a diff in
// any form at all, so a fetch is its only option; `complexity`'s absolute-threshold path is fully approximable
// from the diff text itself, so the cheap in-hunk approximation remains the right scope for THAT AnalyzerName
// specifically -- complexity-delta.ts is where the one-time full-file fetch actually lives.
import type { ComplexityFinding, EnrichRequest } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";
import { DEFAULT_MAX_FINDINGS, DEFAULT_MAX_LINE_CHARS } from "./limits.js";
import { isBasicCommentLine } from "./diff-lines.js";

export const DEFAULT_MAX_COMPLEXITY = 10;
const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const MAX_LINE_CHARS = DEFAULT_MAX_LINE_CHARS;

const JS_TS_PATH_RE = /\.(?:tsx?|jsx?|mts|cts|cjs|mjs)$/i;

const FUNCTION_OPEN_RE =
  /\bfunction\s+(\w+)\s*\([^)]*\)\s*\{|\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*=>\s*\{/;

// Decision-point token classes, each counted as +1 branch. `if` also matches the "if" inside "else if" (correct:
// only the branch "else if" itself introduces should add 1; a bare "else" with no "if" adds 0, matching McCabe
// semantics). for/for-of/for-in/for-await, while (do-while is counted once via its trailing `while(...)`), a
// switch `case` label (never `default`, which is not an additional predicate), `catch`, and the `&&`/`||`/`??`
// short-circuit operators (each occurrence is its own branch). All patterns are flat (no group is itself
// quantified), so none can backtrack catastrophically.
const DECISION_RES: RegExp[] = [
  /\bif\s*\(/g,
  /\bfor\s*(?:await\s*)?\(/g,
  /\bwhile\s*\(/g,
  /\bcatch\s*[({]/g,
  /\bcase\s+/g,
  /&&/g,
  /\|\|/g,
  /\?\?/g,
];

/** Exported so complexity-delta.ts (#4740) applies the IDENTICAL JS/TS-and-not-test file filter this analyzer's
 *  own absolute-threshold path uses -- the two are a matched before/after pair over the same file set, so a
 *  divergent filter between them would be a real (if subtle) correctness bug, not a harmless style choice. */
export function isJsTsPath(path: string): boolean {
  return JS_TS_PATH_RE.test(path) && !isTestPath(path);
}

/** Count decision-point tokens (if/for/while/case/catch/&&/||/??) in one code fragment. Pure. */
export function countDecisionPoints(code: string): number {
  let total = 0;
  for (const re of DECISION_RES) {
    const matches = code.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

/** The declared/assigned name when a line opens a named function declaration or an arrow function assigned to a
 *  const/let/var -- the same structural scope size-smell.ts's function detection uses. Pure. */
export function functionNameFromLine(line: string): string | undefined {
  if (isBasicCommentLine(line)) return undefined;
  const match = FUNCTION_OPEN_RE.exec(codeOnly(line));
  return match?.[1] ?? match?.[2];
}

function braceDepthDelta(code: string): number {
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

/** Given the current pending function (or none) and one added code line, return the updated pending
 *  state -- mutated in place and returned when tracking continues, freshly started when the line opens
 *  a new function, or null when neither applies. Extracted out of scanPatchForComplexity's own loop
 *  (rather than left as an inline if/else) to keep that loop's own control-flow nesting under this
 *  analyzer's sibling deep-nesting.ts threshold. Pure; deciding whether to flush (pending.depth <= 0)
 *  stays the caller's job so this has no dependency on flushFunction's closure. */
function advancePendingFunction(
  pending: PendingFunction | null,
  body: string,
  commented: boolean,
  code: string,
  newLine: number,
): PendingFunction | null {
  if (pending) {
    if (!commented) pending.complexity += countDecisionPoints(code);
    pending.depth += braceDepthDelta(code);
    return pending;
  }
  const name = functionNameFromLine(body);
  if (!name) return null;
  return {
    name,
    startLine: newLine,
    complexity: 1 + (commented ? 0 : countDecisionPoints(code)),
    depth: braceDepthDelta(code),
  };
}

type ScanLimits = {
  maxComplexity?: number;
  maxFindings?: number;
  signal?: AbortSignal;
};

type PendingFunction = {
  name: string;
  startLine: number;
  complexity: number;
  depth: number;
};

/** Scan one file patch's added lines for a newly-added function whose approximate complexity exceeds a
 *  threshold, line-cited via hunk headers. Pure. */
export function scanPatchForComplexity(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): ComplexityFinding[] {
  const configured = limits.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;
  const maxComplexity = configured > 0 ? configured : DEFAULT_MAX_COMPLEXITY;
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isJsTsPath(path)) return [];

  const findings: ComplexityFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  let pending: PendingFunction | null = null;

  const flushFunction = () => {
    if (!pending) return;
    if (pending.complexity > maxComplexity) {
      findings.push({
        file: path,
        line: pending.startLine,
        name: pending.name,
        complexity: pending.complexity,
        threshold: maxComplexity,
      });
    }
    pending = null;
  };

  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flushFunction();
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const commented = isBasicCommentLine(body);
        const code = codeOnly(body);
        pending = advancePendingFunction(pending, body, commented, code, newLine);
        if (pending && pending.depth <= 0) flushFunction();
      }
      newLine++;
    } else {
      flushFunction();
      if (!line.startsWith("-") && !line.startsWith("\\")) {
        newLine++;
      }
    }

    if (findings.length >= maxFindings) return findings;
  }

  flushFunction();
  return findings;
}

/** Analyzer entrypoint: scan every changed TS/JS file's added lines for high approximate complexity. */
export async function scanComplexity(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<ComplexityFinding[]> {
  const findings: ComplexityFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForComplexity(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

/** One function's approximate complexity from a FULL-file scan, keyed by name. Used only to compare two versions
 *  of the SAME file (see complexity-delta.ts, #4740) -- `line` is meaningless on its own across versions since a
 *  function's line number shifts with unrelated edits elsewhere in the file; callers match by NAME, not line. */
export interface ContentComplexityEntry {
  line: number;
  complexity: number;
}

/** Scan an entire file's content -- not just a diff's added lines -- for every function's approximate
 *  complexity, keyed by name and UNFILTERED by any threshold (a low-complexity function is included too, since a
 *  before/after diff needs both sides, not just the ones currently over a limit). This is the "run the same
 *  logic against a full file" counterpart to scanPatchForComplexity: it reuses the exact same function-boundary
 *  detection (`functionNameFromLine`) and decision-point counting (`countDecisionPoints`, via
 *  `advancePendingFunction`/`braceDepthDelta`) rather than reimplementing them, so a before/after comparison is
 *  guaranteed to use identical counting rules on both sides.
 *
 *  A name that recurs more than once (e.g. two top-level declarations sharing a name) is EXCLUDED from the
 *  result entirely -- the same conservative ambiguity rule doc-comment-drift.ts's `extractFunctionParams` already
 *  applies: never guess which occurrence a shared name refers to. A nested function (one whose opening line
 *  appears while another function is already pending) is not tracked as its own entry -- the same accepted
 *  single-level scope limit scanPatchForComplexity already carries -- its decision points still count toward the
 *  OUTER pending function, on both sides of the comparison equally. Pure. */
export function scanContentForComplexity(
  content: string,
  limits: { maxLineChars?: number } = {},
): Map<string, ContentComplexityEntry> {
  const maxLineChars = limits.maxLineChars ?? MAX_LINE_CHARS;
  const byName = new Map<string, ContentComplexityEntry>();
  const seen = new Set<string>();
  let pending: PendingFunction | null = null;

  const flush = () => {
    if (!pending) return;
    const done = pending;
    pending = null;
    if (seen.has(done.name)) {
      byName.delete(done.name); // a second declaration of this name -> ambiguous, exclude it entirely
      return;
    }
    seen.add(done.name);
    byName.set(done.name, { line: done.startLine, complexity: done.complexity });
  };

  const lines = content.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const body = lines[lineNo]!;
    if (body.length > maxLineChars) continue;
    const commented = isBasicCommentLine(body);
    const code = codeOnly(body);
    pending = advancePendingFunction(pending, body, commented, code, lineNo + 1);
    if (pending && pending.depth <= 0) flush();
  }
  flush();
  return byName;
}
