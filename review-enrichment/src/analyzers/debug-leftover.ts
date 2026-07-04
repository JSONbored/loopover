// Leftover debug-statement analyzer (#2015). Flags debugging noise a PR ADDS to non-test source: a `debugger;`
// statement, a bare `console.log`/`console.debug` call (JS/TS), or a bare `print(...)` call (Python). Distinct
// from secret-log.ts, which only fires when a SENSITIVE value reaches a sink; this catches plain debug leftovers
// regardless of payload. Pure compute, no network. Precision-first: string-literal messages are blanked (reusing
// secret-log's codeOnly) and line/block comments are stripped before matching, so `"use console.log"` and
// `// console.log(x)` are never flagged; detection is gated by file extension so a `print(` in a non-Python file
// or a `console.log` mention in prose can't false-positive. Line-cited via hunk headers, mirroring the siblings.
import type { EnrichRequest, DebugLeftoverFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

// Test/spec/generated files are excluded — a `console.log` in a test is not a leftover. Mirrors the skip sets
// already used by undocumented-export.ts / doc-comment-drift.ts.
const SKIP_PATH_RE =
  /(?:\.d\.ts$|\.min\.|\.test\.|\.spec\.|(?:^|\/)__tests__\/|(?:^|\/)tests?\/|(?:^|\/)(?:dist|build|vendor)\/)/i;

const JS_EXTS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
const PY_EXTS = new Set(["py"]);

// A `debugger` statement — required trailing `;` (a bare `debugger` keyword statement conventionally carries one,
// and requiring it avoids matching a property access like `obj.debugger`). The leading class excludes `.debugger`.
const DEBUGGER_RE = /(?:^|[^.\w])debugger\s*;/;
// A bare `console.log`/`console.debug` CALL. The leading `[^.\w]` (or start) excludes `foo.console.log` (a
// property named console) and `myconsole.log`; `console.info`/`.warn`/`.error` are intentional logging, not
// debug leftovers, so they are deliberately NOT matched.
const CONSOLE_RE = /(?:^|[^.\w])console\s*\.\s*(?:log|debug)\s*\(/;
// A bare Python `print(...)` call. The leading class excludes `obj.print(` and keeps `pprint(`/`sprint(` out
// (the char before `print` is a word char there, so the boundary fails).
const PRINT_RE = /(?:^|[^.\w])print\s*\(/;

/** The lowercased final path extension, or null. */
function extOf(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Blank string literals (via codeOnly) then strip comments so only real code is matched. `lang` picks the
 *  comment syntax: JS/TS use `//` and same-line `/* * /`; Python uses `#` (and must NOT strip `//`, which is
 *  integer division). Pure. */
function toCode(line: string, lang: "js" | "py"): string {
  let code = codeOnly(line);
  if (lang === "js") {
    code = code.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "");
  } else {
    code = code.replace(/#.*$/, "");
  }
  return code;
}

/** Classify one added source line for a debug leftover, given its file's language. Returns the kind, or null. */
export function detectDebugLeftover(
  line: string,
  lang: "js" | "py",
): DebugLeftoverFinding["kind"] | null {
  const code = toCode(line, lang);
  // A JSDoc/block-comment continuation line (`* console.log(x)`) is documentation, not code.
  if (code.trimStart().startsWith("*")) return null;
  if (lang === "js") {
    if (DEBUGGER_RE.test(code)) return "debugger";
    if (CONSOLE_RE.test(code)) return "console";
  } else {
    if (PRINT_RE.test(code)) return "print";
  }
  return null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

/** Scan one file patch's added lines for debug leftovers, line-cited via hunk headers. Pure. */
export function scanPatchForDebugLeftover(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): DebugLeftoverFinding[] {
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

  const findings: DebugLeftoverFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patchLines(patch)) {
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
        const kind = detectDebugLeftover(body, lang);
        if (kind) {
          findings.push({ file: path, line: newLine, kind });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line — do not advance the cursor
      // (same class as the iac-misconfig / secret-log fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed non-test source file's added lines for debug leftovers. */
export async function scanDebugLeftover(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<DebugLeftoverFinding[]> {
  const findings: DebugLeftoverFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch || SKIP_PATH_RE.test(file.path)) continue;
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
