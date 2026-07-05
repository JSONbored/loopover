// Deep-nesting / arrow-anti-pattern analyzer (#2030). Flags newly-added control flow whose brace depth
// exceeds a threshold inside a contiguous run of added lines — a readability smell distinct from cyclomatic
// complexity. Pure compute over added diff lines, no network. String literals are stripped before counting.
import type { DeepNestingFinding, EnrichRequest } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

export const DEFAULT_MAX_DEPTH = 4;
const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

/** Advance open-brace depth over one code fragment and return ending depth + peak. Pure. */
export function advanceBraceDepth(
  code: string,
  depth: number,
): { depth: number; peak: number } {
  let peak = depth;
  for (const ch of code) {
    if (ch === "{") {
      depth++;
      peak = Math.max(peak, depth);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
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
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
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
        const next = advanceBraceDepth(codeOnly(body), run.depth);
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
