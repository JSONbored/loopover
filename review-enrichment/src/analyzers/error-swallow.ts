// Error-swallow analyzer (#2014). Flags newly-added catch blocks that swallow the error — an empty body, a body
// that just returns null/undefined, or a body that neither rethrows, logs, nor references the caught binding — a
// top source of silent failures. Pure compute over added diff lines, no network. Scoped to JS/TS (a `catch`
// block) and Python (a bare `except … : pass`). Detection is SINGLE-LINE by design (the catch/except and its
// body on one added line, the compact form the pattern targets): a body spread across multiple lines is not
// tracked — missing it is the safe (false-negative) direction, and there is no cross-line state. String literals
// and comments are blanked first (a `catch {}` in a string, and a comment-only body which is itself a swallow).
// Follows the actions-pin.ts added-line hunk-walk pattern. Line-cited via hunk headers.
import type { EnrichRequest, ErrorSwallowFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const JS_EXTS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
const PY_EXTS = new Set(["py"]);

// A JS/TS `catch` with an OPTIONAL binding and a single-line body captured up to the first `}`.
//   group 1 = the binding name (when `catch (e)`); group 2 = the body between the braces.
const JS_CATCH_RE = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\))?\s*\{([^}]*)\}/;
// A Python bare `except …: pass` — the canonical error-swallow.
const PY_EXCEPT_PASS_RE = /^\s*except\b[^:]*:\s*pass\s*$/;

// Body signals that mean the error is HANDLED, not swallowed: a rethrow, or a logging call.
const RETHROW_RE = /\bthrow\b/;
const LOG_RE = /\b(?:console|logger|log)\s*\.\s*\w+\s*\(|\blog\s*\(|\bwarn\s*\(|\berror\s*\(/i;
// A body that just returns null/undefined — a swallow via a null return.
const RETURN_NULL_RE = /\breturn\s+(?:null|undefined)\s*;?/;

function extOf(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Classify a single added source line for an error-swallow, given its file's language. Returns the kind, or
 *  null. Strings/comments are blanked first so a `catch {}` in a string is not matched. Pure. */
export function detectErrorSwallow(
  line: string,
  lang: "js" | "py",
): ErrorSwallowFinding["kind"] | null {
  if (lang === "py") {
    return PY_EXCEPT_PASS_RE.test(line) ? "empty-catch" : null;
  }
  const code = codeOnly(line).replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "");
  const match = JS_CATCH_RE.exec(code);
  if (!match) return null;
  const binding = match[1];
  const body = (match[2] ?? "").trim();
  if (!body) return "empty-catch";
  if (RETURN_NULL_RE.test(body)) return "return-null";
  // A body that neither rethrows, logs, nor references the caught binding swallows the error. Only meaningful
  // when there IS a binding to ignore — a bindingless `catch { doStuff() }` is not an "unused binding".
  if (
    binding &&
    !new RegExp(`\\b${binding}\\b`).test(body) &&
    !RETHROW_RE.test(body) &&
    !LOG_RE.test(body)
  ) {
    return "unused-binding";
  }
  return null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for error-swallow catch blocks, line-cited via hunk headers. Pure. */
export function scanPatchForErrorSwallow(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): ErrorSwallowFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const ext = extOf(path);
  const lang: "js" | "py" | null = ext
    ? JS_EXTS.has(ext)
      ? "js"
      : PY_EXTS.has(ext)
        ? "py"
        : null
    : null;
  if (!lang) return [];

  const findings: ErrorSwallowFinding[] = [];
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
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const kind = detectErrorSwallow(body, lang);
        if (kind) {
          findings.push({ file: path, line: newLine, kind });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line — do not advance the cursor
      // (same class as the actions-pin / iac-misconfig line-number fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed JS/TS/Python file's added lines for error-swallow catch blocks. */
export async function scanErrorSwallow(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<ErrorSwallowFinding[]> {
  const findings: ErrorSwallowFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForErrorSwallow(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
