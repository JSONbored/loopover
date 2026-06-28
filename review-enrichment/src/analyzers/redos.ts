// ReDoS analyzer (#1503). Flags regex literals INTRODUCED by the PR (added `+` diff lines) that are vulnerable to
// catastrophic backtracking — a group quantified by an unbounded quantifier (`+`, `*`, `{n,}`) whose body ALSO
// contains an unbounded quantifier: the classic `(a+)+` shape that turns attacker-controlled input into a DoS.
// Pure compute, no network, no external detector (structural-only → high precision: linear shapes like `(abc)+`
// are NOT flagged). Line-cited via hunk headers, mirroring the actions-pin analyzer.
import type { EnrichRequest, RedosFinding } from "../types.js";

// Every loop runs over an attacker-controlled patch, so each is bounded.
const MAX_FINDINGS = 25; // keep the brief bounded
const MAX_PATTERN_CHARS = 1000; // ignore absurdly long literals (a hand-written regex is never this long)
const MAX_LINE_CHARS = 2000; // skip extraction on pathologically long lines (defensive)
const REPORT_CHARS = 80; // truncate the reported pattern so the brief stays readable

// Extraction runs as a single LINEAR left-to-right scan — deliberately NOT a regex. A regex with the alternation
// needed here (escapes | char-classes | other chars, all under `+`) has overlapping branches and would itself
// backtrack catastrophically on adversarial diff input (e.g. many empty `[]` classes with no closing `/`). The
// hand scan visits each char once, so the extractor can never be the DoS it exists to detect. Two shapes:
//   - a `/.../flags` literal in regex position (line start, or after a punctuator that cannot end an operand, so
//     `a / b` division is not mistaken for a regex);
//   - a `new RegExp("…")` / `RegExp('…')` / RegExp(`…`) constructor's string argument.
// A slightly-loose extraction is fine: the structural check below is what decides ReDoS, so over-extraction can
// never produce a false finding on its own.

// `/` opens a regex literal (not division) when the char just before it is a statement/operator boundary.
const REGEX_POSITION_PREFIX = "=(,:?&|!{[;";

function isWordChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

function isRegexPosition(line: string, slash: number): boolean {
  if (slash === 0) return true;
  const before = line[slash - 1]!;
  return (
    before === " " || before === "\t" || REGEX_POSITION_PREFIX.includes(before)
  );
}

// From the opening `/` at `open`, linearly consume the literal body (escapes and `[...]` classes are transparent
// to the closing `/`) plus any trailing flags. Returns the body + index past the literal, or null if unterminated.
function scanRegexLiteral(
  line: string,
  open: number,
): { body: string; end: number } | null {
  const n = line.length;
  const bodyStart = open + 1;
  let i = bodyStart;
  let inClass = false;
  while (i < n) {
    const ch = line[i]!;
    if (ch === "\\") {
      if (i + 1 >= n) return null;
      i += 2;
      continue;
    }
    if (ch === "\n") return null;
    if (inClass) {
      if (ch === "]") inClass = false;
      i++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (ch === "/") {
      if (i === bodyStart) return null; // empty body — `//` is a comment, not a regex literal
      let j = i + 1;
      while (j < n && line[j]! >= "a" && line[j]! <= "z") j++;
      return { body: line.slice(bodyStart, i), end: j };
    }
    i++;
  }
  return null;
}

// `RegExp` is expected at `i` (word boundary checked by the caller). Linearly read its first string argument.
// Returns the raw string source + index past the closing quote, or null if it is not a string-literal ctor call.
function scanRegExpCtorArg(
  line: string,
  i: number,
): { body: string; end: number } | null {
  const n = line.length;
  let j = i + "RegExp".length;
  while (j < n && (line[j] === " " || line[j] === "\t")) j++;
  if (line[j] !== "(") return null;
  j++;
  while (j < n && (line[j] === " " || line[j] === "\t")) j++;
  const quote = line[j];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const bodyStart = ++j;
  while (j < n) {
    const ch = line[j]!;
    if (ch === "\\") {
      if (j + 1 >= n) return null;
      j += 2;
      continue;
    }
    if (ch === quote) return { body: line.slice(bodyStart, j), end: j + 1 };
    j++;
  }
  return null;
}

/** Extract candidate regex SOURCES from one line of added code (`/.../` literals + `RegExp(...)` string args). */
export function extractRegexSources(line: string): string[] {
  const sources: string[] = [];
  const n = line.length;
  if (n > MAX_LINE_CHARS) return sources;
  let i = 0;
  while (i < n) {
    const c = line[i]!;
    if (c === "/" && isRegexPosition(line, i)) {
      const lit = scanRegexLiteral(line, i);
      if (lit) {
        if (lit.body.length <= MAX_PATTERN_CHARS) sources.push(lit.body);
        i = lit.end;
        continue;
      }
    } else if (
      c === "R" &&
      (i === 0 || !isWordChar(line[i - 1]!)) &&
      line.startsWith("RegExp", i)
    ) {
      const ctor = scanRegExpCtorArg(line, i);
      if (ctor) {
        if (ctor.body.length <= MAX_PATTERN_CHARS) sources.push(ctor.body);
        i = ctor.end;
        continue;
      }
    }
    i++;
  }
  return sources;
}

// An unbounded quantifier (`+`, `*`, or `{n,}`) at index `i`? `{n}` and `{n,m}` are bounded and ignored.
function unboundedQuantifierAt(p: string, i: number): boolean {
  const c = p[i];
  if (c === "+" || c === "*") return true;
  if (c === "{") return /^\{\d*,\}/.test(p.slice(i));
  return false;
}

// Does the group body p[open+1 .. close-1] contain an unbounded quantifier (ignoring escapes + char classes,
// inside which `+`/`*` are literal)?
function bodyHasUnboundedQuantifier(
  p: string,
  open: number,
  close: number,
): boolean {
  let i = open + 1;
  let inClass = false;
  while (i < close) {
    const c = p[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (unboundedQuantifierAt(p, i)) return true;
    i++;
  }
  return false;
}

/** Catastrophic-backtracking detector: a group `(…)` quantified by an unbounded quantifier whose body ALSO
 *  contains an unbounded quantifier — `(a+)+`, `(\d+)*`, `(.*)+`, … Returns false for linear shapes like `(abc)+`. */
export function hasCatastrophicBacktracking(pattern: string): boolean {
  const openStack: number[] = [];
  let i = 0;
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(") {
      openStack.push(i);
      i++;
      continue;
    }
    if (c === ")") {
      const open = openStack.pop();
      if (
        open !== undefined &&
        unboundedQuantifierAt(pattern, i + 1) &&
        bodyHasUnboundedQuantifier(pattern, open, i)
      ) {
        return true;
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

/** Scan one file patch's added lines for ReDoS-prone regex literals, line-cited via hunk headers. Pure. */
export function scanPatchForRedos(path: string, patch: string): RedosFinding[] {
  const findings: RedosFinding[] = [];
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      for (const source of extractRegexSources(line.slice(1))) {
        if (hasCatastrophicBacktracking(source)) {
          findings.push({
            file: path,
            line: newLine,
            kind: "nested-quantifier",
            pattern: source.slice(0, REPORT_CHARS),
          });
        }
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's added lines for ReDoS-prone regex literals. */
export async function scanRedos(req: EnrichRequest): Promise<RedosFinding[]> {
  const findings: RedosFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch) continue;
    for (const finding of scanPatchForRedos(file.path, file.patch)) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
