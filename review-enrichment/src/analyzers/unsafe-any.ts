// Unsafe-`any` counter analyzer (#2017). Flags explicit `any` type annotations, `as any` casts, and `<any>`
// assertions newly introduced in TypeScript diffs — a type-safety erosion signal for the reviewer. Pure compute
// over added lines in .ts/.tsx files, no network. Structural regex only (no type-checker), fail-safe.
import type { EnrichRequest, UnsafeAnyFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const TS_EXTS = new Set(["ts", "tsx", "mts", "cts"]);

const CAST_RE = /\bas\s+any\b/;
const ASSERTION_RE = /<\s*any\s*>/;
const ANNOTATION_RE = /:\s*any\b/;

function isTypeScriptPath(path: string): boolean {
  const ext = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  return Boolean(ext && TS_EXTS.has(ext) && !isTestPath(path));
}

function stripLineComments(code: string): string {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, " ");
  const slash = noBlock.indexOf("//");
  return slash >= 0 ? noBlock.slice(0, slash) : noBlock;
}

function isFullLineComment(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) return true;
  return /^\s*\/\*[\s\S]*\*\/\s*$/.test(line);
}

type BlockCommentState = { open: boolean };

/** Advance multi-line block-comment state across one hunk line body. Pure aside from state. */
export function advanceBlockCommentState(line: string, state: BlockCommentState): void {
  let scanLine = line;
  if (state.open) {
    const end = scanLine.indexOf("*/");
    if (end < 0) return;
    state.open = false;
    scanLine = scanLine.slice(end + 2);
  }
  while (true) {
    const start = scanLine.indexOf("/*");
    if (start < 0) break;
    const end = scanLine.indexOf("*/", start + 2);
    if (end < 0) {
      state.open = true;
      return;
    }
    scanLine = scanLine.slice(end + 2);
  }
}

/** Remove block-comment spans from one added line, tracking multi-line comment state. Pure aside from state. */
export function stripBlockCommentsFromAddedLine(
  line: string,
  state: BlockCommentState,
): string | null {
  let scanLine = line;
  if (state.open) {
    const end = scanLine.indexOf("*/");
    if (end < 0) return null;
    state.open = false;
    scanLine = scanLine.slice(end + 2);
  }
  while (true) {
    const start = scanLine.indexOf("/*");
    if (start < 0) break;
    const end = scanLine.indexOf("*/", start + 2);
    if (end < 0) {
      scanLine = scanLine.slice(0, start);
      state.open = true;
      break;
    }
    scanLine = `${scanLine.slice(0, start)} ${scanLine.slice(end + 2)}`;
  }
  return scanLine;
}

/** Classify one added TS line for an unsafe-`any` pattern, or null. Pure. */
export function detectUnsafeAny(line: string): UnsafeAnyFinding["kind"] | null {
  if (isFullLineComment(line)) return null;
  const code = stripLineComments(codeOnly(line));
  if (CAST_RE.test(code)) return "cast";
  if (ASSERTION_RE.test(code)) return "assertion";
  if (ANNOTATION_RE.test(code)) return "annotation";
  return null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for unsafe `any`, line-cited via hunk headers. Pure. */
export function scanPatchForUnsafeAny(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): UnsafeAnyFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isTypeScriptPath(path)) return [];
  const findings: UnsafeAnyFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  const blockComment: BlockCommentState = { open: false };

  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      blockComment.open = false;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const scanLine = stripBlockCommentsFromAddedLine(body, blockComment);
        if (scanLine !== null) {
          const kind = detectUnsafeAny(scanLine);
          if (kind) {
            findings.push({ file: path, line: newLine, kind });
            if (findings.length >= maxFindings) return findings;
          }
        }
      }
      newLine++;
    } else if (line.startsWith("-")) {
      advanceBlockCommentState(line.slice(1), blockComment);
    } else if (!line.startsWith("\\")) {
      advanceBlockCommentState(line, blockComment);
      newLine++;
    }
  }

  return findings;
}

/** Analyzer entrypoint: scan every changed TS file's added lines for unsafe `any`. */
export async function scanUnsafeAny(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<UnsafeAnyFinding[]> {
  const findings: UnsafeAnyFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
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
