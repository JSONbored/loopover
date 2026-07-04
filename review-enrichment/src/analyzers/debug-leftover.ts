// Leftover debug-statement analyzer (#2015). Flags debugging noise a PR ADDS to non-test source: a `debugger;`
// statement, a bare `console.log`/`console.debug` call (JS/TS), or a bare `print(...)` call (Python). Distinct
// from secret-log.ts, which only fires when a SENSITIVE value reaches a sink; this catches plain debug leftovers
// regardless of payload. Pure compute, no network. Precision-first: a per-language stripper blanks string
// literals and comments — including MULTI-LINE JS `/* ... */` block comments and Python `"""`/`'''` triple-quoted
// strings, whose open/close state is carried across the added patch lines — before matching, so debug tokens
// that live inside a string or comment are never flagged. Detection is gated by file extension, so a `print(` in
// a non-Python file or a `console.log` mention in prose can't false-positive. Line-cited via hunk headers.
import type { EnrichRequest, DebugLeftoverFinding } from "../types.js";

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

type Lang = "js" | "py";
/** Cross-line comment/string state carried through a file's added lines. */
export interface StripState {
  /** JS: inside an open `/* ... *​/` block comment. */
  block: boolean;
  /** Python: inside an open triple-quoted string, holding the exact opener (`"""` or `'''`). */
  triple: string | null;
}

export function freshStripState(): StripState {
  return { block: false, triple: null };
}

/** The lowercased final path extension, or null. */
function extOf(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Blank comments and string literals in one JS/TS line, carrying block-comment state across lines via `st`.
 *  Returns only the executable code of the line. Pure w.r.t. inputs; mutates `st` to reflect an open block. */
function stripJsLine(line: string, st: StripState): string {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (st.block) {
      const end = line.indexOf("*/", i);
      if (end < 0) return out; // the rest of the line is still comment
      st.block = false;
      out += " ";
      i = end + 2;
      continue;
    }
    const c = line[i]!;
    const c2 = i + 1 < n ? line[i + 1]! : "";
    if (c === "/" && c2 === "/") return out; // line comment — drop the rest
    if (c === "/" && c2 === "*") {
      st.block = true;
      out += " ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // A single-line string/template literal — skip to its close (respecting `\`). An unterminated quote
      // consumes to EOL, which is the safe (blank-more) direction. Cross-line template literals are not
      // tracked (a bare debug call split across template lines is not a realistic leftover shape).
      i++;
      while (i < n && line[i] !== c) {
        if (line[i] === "\\") i++;
        i++;
      }
      i++;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Blank comments and string literals in one Python line, carrying triple-quoted-string state across lines. */
function stripPyLine(line: string, st: StripState): string {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (st.triple) {
      const end = line.indexOf(st.triple, i);
      if (end < 0) return out; // still inside the triple-quoted string
      i = end + 3;
      st.triple = null;
      out += " ";
      continue;
    }
    const c = line[i]!;
    if (c === "#") return out; // line comment — drop the rest
    const triple = line.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      st.triple = triple;
      out += " ";
      i += 3;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && line[i] !== c) {
        if (line[i] === "\\") i++;
        i++;
      }
      i++;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripLine(line: string, lang: Lang, st: StripState): string {
  return lang === "js" ? stripJsLine(line, st) : stripPyLine(line, st);
}

function classify(code: string, lang: Lang): DebugLeftoverFinding["kind"] | null {
  // A JSDoc/block-comment continuation line (`* console.log(x)`) whose opening `/*` is outside the hunk — the
  // block state above never saw it — is still documentation, not code.
  if (code.trimStart().startsWith("*")) return null;
  if (lang === "js") {
    if (DEBUGGER_RE.test(code)) return "debugger";
    if (CONSOLE_RE.test(code)) return "console";
  } else {
    if (PRINT_RE.test(code)) return "print";
  }
  return null;
}

/** Classify one added source line for a debug leftover, given its file's language. Single-line semantics: a
 *  fresh strip state is used, so an open block comment / triple string is not carried in. Pure. */
export function detectDebugLeftover(
  line: string,
  lang: Lang,
): DebugLeftoverFinding["kind"] | null {
  return classify(stripLine(line, lang, freshStripState()), lang);
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

/** Scan one file patch's added lines for debug leftovers, line-cited via hunk headers. Comment/string state is
 *  carried across the added lines so a multi-line block comment / triple-quoted string is fully suppressed.
 *  Pure. */
export function scanPatchForDebugLeftover(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): DebugLeftoverFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const ext = extOf(path);
  const lang: Lang | null = ext
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
  // Comment/string state persists only within a contiguous hunk of added lines; a hunk header resets it,
  // since a new hunk can start anywhere in the file and inheriting a stale open-comment flag would be wrong.
  let state = freshStripState();
  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      state = freshStripState();
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const code = stripLine(body, lang, state);
        const kind = classify(code, lang);
        if (kind) {
          findings.push({ file: path, line: newLine, kind });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line — do not advance the cursor
      // (same class as the iac-misconfig / secret-log fix). A removed line does not change the new file's
      // comment/string state, so `state` is left untouched here.
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
