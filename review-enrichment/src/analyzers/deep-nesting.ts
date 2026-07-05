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

/** True when `{` opens control-flow scope (if/for/try/=>/function), not an object literal. Pure. */
export function isControlFlowOpenBrace(code: string, braceIdx: number): boolean {
  const before = code.slice(0, braceIdx).trimEnd();
  if (/(?:=>|\belse|\btry|\bfinally|\bdo)\s*$/i.test(before)) return true;
  if (/\b(?:if|for|while|switch|catch|with)\s*\([^)]*\)\s*$/i.test(before)) return true;
  if (/\b(?:async\s+)?function(?:\s+\w+)?\s*\([^)]*\)\s*$/i.test(before)) return true;
  return false;
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
