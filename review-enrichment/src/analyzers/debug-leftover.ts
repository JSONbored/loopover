// Debug-leftover analyzer (#2015). Flags debugging leftovers introduced in the diff — `debugger;` statements
// and bare `console.*` / `print()` calls added to non-test source files. Distinct from the secret-log analyzer
// (which only fires on sensitive-value sinks); this catches plain debug noise regardless of payload. Pure compute,
// no network. String-literal content is stripped before matching so a `"console.log('hi')"` inside a string is
// not flagged. Line-cited via hunk headers, mirroring the sibling local analyzers.
import type { DebugLeftoverFinding, EnrichRequest } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const DEBUGGER_RE = /\bdebugger\s*;/;
const CONSOLE_RE = /\bconsole\s*\.\s*(?:log|debug|info|warn|error|trace|dir|table)\s*\(/;
const PRINT_RE = /\bprint\s*\(/;

/** Classify one added line for a debug leftover, or null. Pure. */
export function detectDebugLeftover(line: string): DebugLeftoverFinding["kind"] | null {
  const code = codeOnly(line);
  if (DEBUGGER_RE.test(code)) return "debugger";
  if (CONSOLE_RE.test(code)) return "console";
  if (PRINT_RE.test(code)) return "print";
  return null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for debug leftovers, line-cited via hunk headers. Pure. */
export function scanPatchForDebugLeftover(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): DebugLeftoverFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || isTestPath(path)) return [];
  const findings: DebugLeftoverFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const kind = detectDebugLeftover(body);
        if (kind) {
          findings.push({ file: path, line: newLine, kind });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed non-test file's added lines for debug leftovers. */
export async function scanDebugLeftover(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<DebugLeftoverFinding[]> {
  const findings: DebugLeftoverFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForDebugLeftover(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
