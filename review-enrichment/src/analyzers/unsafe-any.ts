// Unsafe-`any` analyzer (#2017). Counts and locates explicit `any` type annotations, `<any>` assertions, and
// `as any` casts newly introduced in TypeScript diffs — a type-safety erosion signal for the reviewer. Pure
// compute over added lines in .ts/.tsx/.mts/.cts files only; structural regex (no type-checker), fail-safe.
import type { EnrichRequest, UnsafeAnyFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const TS_PATH_RE = /\.(?:tsx?|mts|cts)$/i;

function isTsPath(path: string): boolean {
  return TS_PATH_RE.test(path) && !isTestPath(path);
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^(?:\/\/|\/\*|\*)/.test(trimmed);
}

/** Classify one added line for an unsafe `any` pattern, or null. Pure. */
export function detectUnsafeAny(line: string): UnsafeAnyFinding["kind"] | null {
  if (isCommentLine(line) || line.length > MAX_LINE_CHARS) return null;
  const code = codeOnly(line);
  if (/\bas any\b/.test(code)) return "cast";
  if (/<any>/.test(code)) return "assertion";
  if (/:\s*any\b/.test(code)) return "annotation";
  return null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  while (start <= patch.length) {
    const end = patch.indexOf("\n", start);
    if (end === -1) {
      yield patch.slice(start);
      return;
    }
    yield patch.slice(start, end);
    start = end + 1;
  }
}

/** Scan one file patch's added lines for unsafe `any` usage, line-cited via hunk headers. Pure. */
export function scanPatchForUnsafeAny(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): UnsafeAnyFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isTsPath(path)) return [];
  const findings: UnsafeAnyFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) return findings;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const kind = detectUnsafeAny(line.slice(1));
      if (kind) {
        findings.push({ file: path, line: newLine, kind });
        if (findings.length >= maxFindings) return findings;
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's added lines for unsafe `any` usage. */
export async function scanUnsafeAny(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<UnsafeAnyFinding[]> {
  const findings: UnsafeAnyFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) return findings;
    if (!file.patch) continue;
    for (const finding of scanPatchForUnsafeAny(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
