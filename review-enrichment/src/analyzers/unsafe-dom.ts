// Unsafe DOM / code-execution sink analyzer. Flags added JS/TS lines that pass data into a DOM-HTML or a
// dynamic-code-execution sink — `el.innerHTML = x`, `dangerouslySetInnerHTML={…}`, `document.write(…)`,
// `eval(…)`, `new Function(…)`, `setTimeout("code", …)` — a client-side XSS / arbitrary-code-execution surface
// distinct from the secret-into-a-LOG-sink scan (secret-log inspects logging sinks) and the regex-backtracking
// SHAPE scan (redos). Pure compute, no network. Precision-first: string-literal, regex-literal, AND `//` line-comment
// content is stripped before matching (own linear-pass `codeOnly`, no regex, so it can never backtrack), so an
// `innerHTML` named inside a string, a `/.../ ` regex, or a comment is not flagged. Line-cited via hunk headers.
import type { EnrichRequest, UnsafeDomFinding } from "../types.js";

const MAX_FINDINGS = 25; // keep the brief bounded
const MAX_LINE_CHARS = 2000; // skip pathologically long lines (defensive)

// Only scan source files: these sinks are meaningful in JS/TS/JSX/TSX and single-file component sources, not in
// config, data, or docs. Keeps the signal high and avoids matching prose in YAML/JSON/Markdown.
const CODE_PATH_RE = /\.(?:jsx?|tsx?|mjs|cjs|mts|cts|vue|svelte)$/i;

// All matchers below are FLAT alternations (no group is itself quantified), so each is linear-time — this analyzer
// can never be the ReDoS class it sits beside. Each kind is a separate flat regex run on the code-only line.
//
// DOM-HTML write sinks: assignment to innerHTML/outerHTML (not the `==`/`===` comparison), or insertAdjacentHTML().
const INNER_HTML_RE = /\.(?:innerHTML|outerHTML)\s*=(?!=)|\.insertAdjacentHTML\s*\(/;
// React/JSX raw-HTML escape hatch.
const DANGEROUS_JSX_RE = /\bdangerouslySetInnerHTML\b/;
// Legacy document.write / document.writeln HTML injection.
const DOCUMENT_WRITE_RE = /\bdocument\s*\.\s*write(?:ln)?\s*\(/;
// Global eval(...) — boundary-gated so member calls (`obj.eval(`) and identifier substrings (`retrieval(`) are excluded.
const EVAL_CALL_RE = /(?:^|[^.\w$])eval\s*\(/;
// The Function constructor compiles a string into code.
const FUNCTION_CTOR_RE = /\bnew\s+Function\s*\(/;
// setTimeout/setInterval with a STRING (or template) first argument is an implicit eval; a function first arg is safe.
// SET_TIMER_CALL_RE confirms a real call survives codeOnly (so a setTimeout named in a comment/string is excluded);
// SET_TIMER_STRING_RE confirms the first argument is a string/template — tested on the ORIGINAL line because
// codeOnly blanks string/template bodies, which would otherwise erase the very signal this kind depends on.
const SET_TIMER_CALL_RE = /\bset(?:Timeout|Interval)\s*\(/;
const SET_TIMER_STRING_RE = /\bset(?:Timeout|Interval)\s*\(\s*['"`]/;

/** Blank out string-literal content, regex-literal bodies, and `//` line-comment tails in a single linear pass — no
 *  regex, so it can never backtrack. `${…}` template-interpolation bodies are kept (they are real code). Lets the
 *  matchers above run against code, not string/regex/comment prose, so an `innerHTML` mentioned in a string, a
 *  `/.../ ` regex literal, or a comment is not a hit. */
export function codeOnly(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === "/" && s[i + 1] === "/") {
      break; // line comment — drop the rest of the line
    }
    if (c === "/") {
      // Distinguish a regex literal from a division operator: a regex can begin only where an expression is
      // expected (line start, or right after an operator / open bracket), never after a value (identifier,
      // number, `)`, or `]`). Skip a regex body so a sink-looking token inside `/.../` (e.g. /document\.write\(/)
      // is not matched as real code — this is the false-positive class regex-unaware sink scanners suffer from.
      let k = out.length - 1;
      while (k >= 0 && (out[k] === " " || out[k] === "\t")) k--;
      const prev = k >= 0 ? out[k]! : "";
      if (prev === "" || "(,=:[!&|?{;+-*%<>~^".includes(prev)) {
        i++; // past the opening slash
        let inClass = false; // inside a [...] character class a `/` is literal, not the terminator
        while (i < n) {
          const ch = s[i];
          if (ch === "\\") {
            i += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            i++; // closing slash
            break;
          }
          i++;
        }
        out += " ";
        continue;
      }
      out += c; // division operator — keep it as code
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && s[i] !== c) {
        if (s[i] === "\\") i++;
        i++;
      }
      i++; // closing quote
      out += " ";
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && s[i] !== "`") {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === "$" && s[i + 1] === "{") {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (s[i] === "{") depth++;
            else if (s[i] === "}") depth--;
            if (depth > 0) out += s[i];
            i++;
          }
          continue;
        }
        i++; // ordinary template-literal char — drop it
      }
      i++; // closing backtick
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function sinkLabel(match: string): string {
  return match.replace(/\s+/g, "").replace(/\($/, "");
}

/** Classify one line: does it write to a DOM-HTML sink or execute a dynamic-code sink? Returns the kind + a
 *  public-safe sink label, or null. String/comment content is stripped first so only real code matches. */
export function detectUnsafeDom(
  line: string,
): { kind: UnsafeDomFinding["kind"]; sink: string } | null {
  const code = codeOnly(line);
  let m: RegExpExecArray | null;
  if ((m = INNER_HTML_RE.exec(code)))
    return { kind: "inner-html", sink: sinkLabel(m[0]) };
  if (DANGEROUS_JSX_RE.test(code))
    return { kind: "dangerous-jsx", sink: "dangerouslySetInnerHTML" };
  if ((m = DOCUMENT_WRITE_RE.exec(code)))
    return { kind: "document-write", sink: sinkLabel(m[0]) };
  if (EVAL_CALL_RE.test(code)) return { kind: "eval-call", sink: "eval" };
  if (FUNCTION_CTOR_RE.test(code))
    return { kind: "function-ctor", sink: "new Function" };
  if (SET_TIMER_CALL_RE.test(code) && (m = SET_TIMER_STRING_RE.exec(line)))
    return { kind: "set-timeout-string", sink: sinkLabel(m[0]) };
  return null;
}

type UnsafeDomScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

function* patchLines(patch: string): Generator<string> {
  // Stream by patch line so large diffs do not require an intermediate split array; abort is sampled per line below.
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

/** Scan one file patch's added lines for unsafe DOM / code-execution sinks, line-cited via hunk headers. Pure. */
export function scanPatchForUnsafeDom(
  path: string,
  patch: string,
  limits: UnsafeDomScanLimits = {},
): UnsafeDomFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const findings: UnsafeDomFinding[] = [];
  let newLine = 0;
  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const hit = detectUnsafeDom(body);
        if (hit) {
          findings.push({
            file: path,
            line: newLine,
            kind: hit.kind,
            sink: hit.sink,
          });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed source file's added lines for unsafe DOM / code-execution sinks. */
export async function scanUnsafeDom(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<UnsafeDomFinding[]> {
  const findings: UnsafeDomFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch || !CODE_PATH_RE.test(file.path)) continue;
    for (const finding of scanPatchForUnsafeDom(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      // The per-file scan is capped to the remaining budget; keep this as a final invariant if that scanner changes.
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
