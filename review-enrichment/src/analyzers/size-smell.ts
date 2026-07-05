// Size-smell analyzer (#2019). Flags maintainability smells from patch structure alone: a changed file
// whose estimated resulting length exceeds a threshold, or a newly-added function body whose brace span is
// too long. Pure compute over diff hunks, no network. Skips test paths.
import type { EnrichRequest, SizeSmellFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

export const DEFAULT_MAX_FILE_LINES = 400;
export const DEFAULT_MAX_FUNCTION_LINES = 60;
const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const FUNCTION_BODY_OPEN_RE =
  /\bfunction\s+(\w+)\s*\([^)]*\)\s*\{|\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*=>\s*\{/;

type ScanLimits = {
  maxFileLines?: number;
  maxFunctionLines?: number;
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Estimate the resulting file length from unified-diff hunk headers. Pure. */
export function estimateFileLengthFromPatch(patch: string): number {
  let maxEndLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (!hunk) continue;
    const newStart = Number(hunk[3]);
    const newLen = hunk[4] ? Number(hunk[4]) : 1;
    maxEndLine = Math.max(maxEndLine, newStart + newLen - 1);
  }
  return maxEndLine;
}

function functionNameFromLine(line: string): string | undefined {
  const code = codeOnly(line);
  const match = FUNCTION_BODY_OPEN_RE.exec(code);
  if (!match) return undefined;
  return match[1] ?? match[2];
}

function braceDepthDelta(code: string): number {
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

type PendingFunction = {
  name: string;
  startLine: number;
  bodyLines: number;
  depth: number;
};
export function scanPatchForSizeSmell(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): SizeSmellFinding[] {
  const maxFileLines = limits.maxFileLines ?? DEFAULT_MAX_FILE_LINES;
  const maxFunctionLines = limits.maxFunctionLines ?? DEFAULT_MAX_FUNCTION_LINES;
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || isTestPath(path)) return [];

  const findings: SizeSmellFinding[] = [];
  const fileLength = estimateFileLengthFromPatch(patch);
  if (fileLength > maxFileLines) {
    findings.push({
      file: path,
      kind: "long-file",
      measure: fileLength,
      threshold: maxFileLines,
    });
    if (findings.length >= maxFindings) return findings;
  }

  let newLine = 0;
  let inHunk = false;
  let pending: PendingFunction | null = null;

  const flushFunction = () => {
    if (!pending) return;
    if (pending.bodyLines > maxFunctionLines) {
      findings.push({
        file: path,
        line: pending.startLine,
        kind: "big-function",
        measure: pending.bodyLines,
        threshold: maxFunctionLines,
        name: pending.name,
      });
    }
    pending = null;
  };

  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      flushFunction();
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const code = codeOnly(body);
        if (pending) {
          pending.bodyLines++;
          pending.depth += braceDepthDelta(code);
          if (pending.depth <= 0) flushFunction();
        } else {
          const name = functionNameFromLine(body);
          if (name) {
            pending = {
              name,
              startLine: newLine,
              bodyLines: 1,
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

/** Analyzer entrypoint: scan changed non-test files for size smells. */
export async function scanSizeSmell(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<SizeSmellFinding[]> {
  const findings: SizeSmellFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForSizeSmell(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
