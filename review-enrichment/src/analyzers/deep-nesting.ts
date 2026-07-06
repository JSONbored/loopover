// Deep-nesting / arrow-anti-pattern analyzer (#2030). Flags newly-added control flow whose
// control-flow brace depth exceeds a threshold inside a contiguous run of added lines — a readability
// smell distinct from cyclomatic complexity. Object-literal braces are tracked but do not increase depth.
// Pure compute over added diff lines, no network.
import type { DeepNestingFinding, EnrichRequest } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

export const DEFAULT_MAX_DEPTH = 4;
const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

type BraceKind = "control" | "other";

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || ch === "_" || ch === "$";
}

function previousNonSpace(code: string, fromExclusive: number): number {
  for (let i = fromExclusive - 1; i >= 0; i--) {
    if (!isWhitespace(code[i]!)) return i;
  }
  return -1;
}

function readWordBefore(code: string, fromInclusive: number): { word: string; start: number } | undefined {
  let end = fromInclusive;
  while (end >= 0 && !isWordChar(code[end]!)) end--;
  if (end < 0) return undefined;

  let start = end;
  while (start >= 0 && isWordChar(code[start]!)) start--;
  return { word: code.slice(start + 1, end + 1).toLowerCase(), start: start + 1 };
}

function matchingOpenParen(code: string, closeIdx: number): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const ch = code[i]!;
    if (ch === ")") {
      depth++;
    } else if (ch === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when `{` opens control-flow scope (if/for/try/=>/function), not an object literal. Pure. */
export function isControlFlowOpenBrace(code: string, braceIdx: number): boolean {
  const beforeEnd = previousNonSpace(code, braceIdx);
  if (beforeEnd < 0) return false;

  if (code[beforeEnd] === ">" && code[previousNonSpace(code, beforeEnd)] === "=") return true;

  const directWord = readWordBefore(code, beforeEnd);
  if (directWord && ["else", "try", "finally", "do"].includes(directWord.word)) return true;

  if (code[beforeEnd] !== ")") return false;

  const openParen = matchingOpenParen(code, beforeEnd);
  if (openParen < 0) return false;
  const callee = readWordBefore(code, previousNonSpace(code, openParen));
  if (!callee) return false;
  if (["if", "for", "while", "switch", "catch", "with"].includes(callee.word)) return true;

  if (callee.word === "function") return true;
  const maybeFunction = readWordBefore(code, previousNonSpace(code, callee.start));
  if (maybeFunction?.word !== "function") return false;
  const maybeAsync = readWordBefore(code, previousNonSpace(code, maybeFunction.start));
  return !maybeAsync || maybeAsync.word === "async";
}

/** Advance control-flow brace depth over one code fragment and return ending depth + peak. Pure. */
export function advanceControlFlowDepth(
  code: string,
  depth: number,
): { depth: number; peak: number } {
  let peak = depth;
  const stack: BraceKind[] = [];

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "{") {
      const kind: BraceKind = isControlFlowOpenBrace(code, i) ? "control" : "other";
      stack.push(kind);
      if (kind === "control") {
        depth++;
        peak = Math.max(peak, depth);
      }
      continue;
    }
    if (ch === "}") {
      const kind = stack.pop();
      if (kind === "control") {
        depth = Math.max(0, depth - 1);
      }
    }
  }

  return { depth, peak };
}

type ScanLimits = {
  maxDepth?: number;
  maxFindings?: number;
  signal?: AbortSignal;
};

type RunState = {
  depth: number;
  flagged: boolean;
};

function resetRun(state: RunState): void {
  state.depth = 0;
  state.flagged = false;
}

/** Scan one file patch's added lines for deep nesting, line-cited via hunk headers. Pure. */
export function scanPatchForDeepNesting(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): DeepNestingFinding[] {
  const configured = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDepth = configured > 0 ? configured : DEFAULT_MAX_DEPTH;
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || isTestPath(path)) return [];
  const findings: DeepNestingFinding[] = [];
  const run: RunState = { depth: 0, flagged: false };
  let newLine = 0;
  let inHunk = false;

  const maybeFlag = (line: number, depth: number) => {
    if (run.flagged || depth <= maxDepth) return;
    findings.push({ file: path, line, depth, threshold: maxDepth });
    run.flagged = true;
  };

  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      resetRun(run);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const next = advanceControlFlowDepth(codeOnly(body), run.depth);
        run.depth = next.depth;
        maybeFlag(newLine, next.peak);
        if (findings.length >= maxFindings) return findings;
      }
      newLine++;
    } else {
      resetRun(run);
      if (!line.startsWith("-") && !line.startsWith("\\")) {
        newLine++;
      }
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed non-test file's added lines for deep nesting. */
export async function scanDeepNesting(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<DeepNestingFinding[]> {
  const findings: DeepNestingFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForDeepNesting(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
