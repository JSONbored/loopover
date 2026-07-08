// Approximate cyclomatic-complexity analyzer (#1477). REES has no full-file content -- only diff hunks -- so
// this is deliberately NOT a whole-function true McCabe count (that needs a real parser reading the ENTIRE
// function, including any part outside the diff, and a new AST-parser dependency this service does not carry).
// Instead it approximates: for each newly-added function whose OPENING line is visible in the diff (named
// `function` declarations and arrow functions assigned to const/let/var -- the same structural detection
// size-smell.ts (#2019) already uses for "big-function"), it counts branch/loop/logical-operator tokens across
// the function's ADDED body lines only and reports `1 + that count`, the standard McCabe formula computed on
// the visible slice. A function whose signature line is NOT part of the diff (only its body was edited) is not
// attributed a complexity score, the same accepted scope limit size-smell.ts already carries for "big-function".
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
// Pure compute over added diff lines, no network, no new dependency. churn-hotspot (#1513) is not precedent for
// a broader one-time fetch here: it fetches commit METADATA that cannot exist in a diff in any form at all, so a
// fetch is its only option; complexity is partially approximable from the diff text itself, so the cheap
// in-hunk approximation -- not a full-file fetch -- is the right scope for this analyzer.
import type { ComplexityFinding, EnrichRequest } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

export const DEFAULT_MAX_COMPLEXITY = 10;
const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

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

function isJsTsPath(path: string): boolean {
  return JS_TS_PATH_RE.test(path) && !isTestPath(path);
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^(?:\/\/|\/\*|\*)/.test(trimmed);
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
  if (isCommentLine(line)) return undefined;
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
        const commented = isCommentLine(body);
        const code = codeOnly(body);
        if (pending) {
          if (!commented) pending.complexity += countDecisionPoints(code);
          pending.depth += braceDepthDelta(code);
          if (pending.depth <= 0) flushFunction();
        } else {
          const name = functionNameFromLine(body);
          if (name) {
            pending = {
              name,
              startLine: newLine,
              complexity: 1 + (commented ? 0 : countDecisionPoints(code)),
              depth: braceDepthDelta(code),
            };
            if (pending.depth <= 0) flushFunction();
          }
        }
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
