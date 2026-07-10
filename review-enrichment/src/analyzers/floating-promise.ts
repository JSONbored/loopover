// Floating-promise analyzer (#2023). Flags newly-added async-shaped calls whose returned promise is neither
// awaited, returned, voided, nor .catch()/.then()-chained on the same statement — a common silent-failure bug.
// Precision-first structural heuristic over added TS/JS lines only: promise-shaped callees (`fetch`, `Promise.*`,
// or an `*Async` suffix) on bare expression statements. Pure compute, no network.
import type { EnrichRequest, FloatingPromiseFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";
import { DEFAULT_MAX_FINDINGS, DEFAULT_MAX_LINE_CHARS } from "./limits.js";
import { isBasicCommentLine } from "./diff-lines.js";

const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const MAX_LINE_CHARS = DEFAULT_MAX_LINE_CHARS;
const MAX_CALL_CHARS = 40;

const JS_TS_PATH_RE = /\.(?:tsx?|jsx?|mts|cts|cjs|mjs)$/i;

const HANDLED_PREFIX =
  /^\s*(?:await\b|return\b|void\b|throw\b|if\b|for\b|while\b|switch\b|case\b|else\b|try\b|catch\b|finally\b|import\b|export\b|const\b|let\b|var\b|type\b|interface\b|class\b|function\b|async\s+function\b)/;

const PROMISE_CHAIN_RE = /\.(?:then|catch)\s*\(/;

function isJsTsPath(path: string): boolean {
  return JS_TS_PATH_RE.test(path) && !isTestPath(path);
}

function truncateCall(call: string): string {
  if (call.length <= MAX_CALL_CHARS) return call;
  return `${call.slice(0, MAX_CALL_CHARS - 3)}...`;
}

function isPromiseShapedCallee(callee: string): boolean {
  if (callee === "fetch" || callee.endsWith(".fetch")) return true;
  if (callee === "Promise" || /^Promise\.(?:all(?:Settled)?|race|any|resolve|reject)$/.test(callee)) {
    return true;
  }
  const last = callee.split(".").pop() ?? callee;
  return /Async$/.test(last);
}

function extractLeadingCallCallee(line: string): string | null {
  const code = codeOnly(line).trim();
  const semiIdx = code.indexOf(";");
  if (semiIdx >= 0 && semiIdx < code.length - 1) {
    const after = code.slice(semiIdx + 1).trim();
    if (after.length > 0) return null;
  }

  const newPromise = /^new\s+Promise\s*\(/.exec(code);
  if (newPromise) return "Promise";

  const match = /^((?:[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*))\s*\(/.exec(code);
  return match?.[1] ?? null;
}

/** Classify one added line for a floating promise call, or null. Pure. */
export function detectFloatingPromise(line: string): string | null {
  if (isBasicCommentLine(line) || HANDLED_PREFIX.test(line)) {
    return null;
  }

  const code = codeOnly(line).replace(/=>/g, "  ");
  if (PROMISE_CHAIN_RE.test(code)) return null;
  if (/(?<![=<>!])=(?!=)/.test(code)) return null;

  const callee = extractLeadingCallCallee(line);
  if (!callee || !isPromiseShapedCallee(callee)) return null;

  return truncateCall(callee);
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for floating promises, line-cited via hunk headers. Pure. */
export function scanPatchForFloatingPromise(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): FloatingPromiseFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isJsTsPath(path)) return [];
  const findings: FloatingPromiseFinding[] = [];
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
        const call = detectFloatingPromise(body);
        if (call) {
          findings.push({ file: path, line: newLine, call });
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

/** Analyzer entrypoint: scan every changed TS/JS file's added lines for floating promises. */
export async function scanFloatingPromise(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<FloatingPromiseFinding[]> {
  const findings: FloatingPromiseFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForFloatingPromise(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
