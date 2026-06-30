// Unsafe DOM / code-execution sink analyzer. Flags added JS/TS lines that pass data into a DOM-HTML write sink
// (`el.innerHTML = x`, `dangerouslySetInnerHTML={…}`, `document.write(…)`, `insertAdjacentHTML(…)`) or a dynamic
// code-execution sink (`eval(…)`, `new Function(…)`, a string-bodied `setTimeout`/`setInterval`) — a client-side
// XSS / arbitrary-code-execution surface distinct from the secret-into-a-LOG-sink scan (secret-log) and the
// regex-backtracking SHAPE scan (redos). Pure compute, no network. Precision-first: `codeOnly` reduces a line to
// just its code — blanking string contents (keeping the quotes), recursively stripping `${…}` interpolation
// bodies, dropping regex-literal bodies, and dropping `//` and `/* */` comments (block comments are tracked across
// added lines) — in a single linear pass with no regex, so it can never backtrack. Every sink is then matched
// against that code view, so a sink named inside a string, interpolation string, regex, or comment is never
// flagged. Line-cited via hunk headers, mirroring the other local analyzers.
import type { EnrichRequest, UnsafeDomFinding } from "../types.js";

const MAX_FINDINGS = 25; // keep the brief bounded
const MAX_LINE_CHARS = 2000; // skip pathologically long lines (defensive)

// Only scan source files: these sinks are meaningful in JS/TS/JSX/TSX and single-file component sources, not in
// config, data, or docs. This is an intentional precision tradeoff — extensionless entrypoints or unusual
// framework filenames are skipped to keep the signal high and avoid matching prose in YAML/JSON/Markdown.
const CODE_PATH_RE = /\.(?:jsx?|tsx?|mjs|cjs|mts|cts|vue|svelte)$/i;

// All matchers below are FLAT alternations (no group is itself quantified), so each is linear-time — this analyzer
// can never be the ReDoS class it sits beside. Each runs against the code-only view of the line.
//
// DOM-HTML write sinks: plain or compound assignment to innerHTML/outerHTML (`=` or `+=`, but not the `==`/`===`
// comparison), or insertAdjacentHTML().
const INNER_HTML_RE = /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(/;
// React/JSX raw-HTML escape hatch — narrowed to a prop/object assignment (`dangerouslySetInnerHTML={…}` or
// `dangerouslySetInnerHTML: {…}`) so a bare identifier of the same name is not flagged.
const DANGEROUS_JSX_RE = /\bdangerouslySetInnerHTML\s*[=:]\s*\{/;
// Legacy document.write / document.writeln HTML injection.
const DOCUMENT_WRITE_RE = /\bdocument\s*\.\s*write(?:ln)?\s*\(/;
// Global eval(...) — boundary-gated so member calls (`obj.eval(`) and identifier substrings (`retrieval(`) are excluded.
const EVAL_CALL_RE = /(?:^|[^.\w$])eval\s*\(/;
// The Function constructor compiles a string into code.
const FUNCTION_CTOR_RE = /\bnew\s+Function\s*\(/;
// setTimeout/setInterval with a STRING (or template) first argument is an implicit eval; a function first arg is safe.
// Matched against the code-only view, where string contents are blanked but the quotes are kept, so the
// string-first-argument signal survives while a `setTimeout` named in a comment/string/interpolation does not.
const SET_TIMER_STRING_RE = /\bset(?:Timeout|Interval)\s*\(\s*['"`]/;

function isWordChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

// Keywords after which a `/` begins a regex literal, not a division — `return /re/`, `typeof /re/`, etc.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "throw",
  "await",
  "case",
]);

/** Decide whether a `/` begins a regex literal (vs a division operator), from the code emitted so far. A regex can
 *  begin at expression start: line start, after an operator/open-bracket, or after an expression-start keyword —
 *  never after a value (identifier, number, `)`, or `]`). No regex used here. */
function isRegexStart(out: string): boolean {
  let k = out.length - 1;
  while (k >= 0 && (out[k] === " " || out[k] === "\t")) k--;
  if (k < 0) return true; // line start ⇒ expression position
  const ch = out[k]!;
  if (isWordChar(ch)) {
    let j = k;
    while (j >= 0 && isWordChar(out[j]!)) j--;
    return REGEX_PRECEDING_KEYWORDS.has(out.slice(j + 1, k + 1));
  }
  if (ch === ")" || ch === "]") return false; // division after a value
  return "(,=:[!&|?{;+-*%<>~^".includes(ch); // operator / open bracket ⇒ regex
}

/** Reduce a line to just its code, returning the stripped code plus whether the line ends inside an unterminated
 *  `/* *​/` block comment (so the scanner can carry that state to the next added line). Blanks string contents
 *  (keeping the quotes), recursively strips `${…}` interpolation bodies, drops regex-literal bodies, and drops
 *  `//` line and `/* *​/` block comments. Single linear pass, no regex, so it can never backtrack. `startInBlock`
 *  continues a block comment opened on a previous line. */
export function codeOnly(
  s: string,
  startInBlock = false,
): { code: string; inBlock: boolean } {
  let out = "";
  let i = 0;
  const n = s.length;
  if (startInBlock) {
    while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++;
    if (i >= n) return { code: " ", inBlock: true }; // comment still open at end of line
    i += 2;
    out += " ";
  }
  while (i < n) {
    const c = s[i]!;
    if (c === "/" && s[i + 1] === "/") {
      break; // line comment — drop the rest of the line
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++;
      if (i >= n) {
        out += " ";
        return { code: out, inBlock: true }; // block comment runs past end of line
      }
      i += 2;
      out += " ";
      continue;
    }
    if (c === "/") {
      if (isRegexStart(out)) {
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
      out += "/"; // division operator — keep it as code
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
      out += c + c; // keep an empty quoted literal (e.g. "" / '') so a string first-arg stays detectable
      continue;
    }
    if (c === "`") {
      out += "`";
      i++;
      while (i < n && s[i] !== "`") {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === "$" && s[i + 1] === "{") {
          // Collect the interpolation body with brace matching that skips strings, nested templates, and regex
          // literals — so a `}` inside any of them does not close the interpolation early and swallow a later
          // real sink — then strip the body with the same machine (recursively) so a sink that is only string/
          // regex/comment text inside the interpolation does not survive as code.
          i += 2;
          let depth = 1;
          let inner = "";
          while (i < n && depth > 0) {
            const ic = s[i]!;
            if (ic === '"' || ic === "'") {
              inner += ic;
              i++;
              while (i < n && s[i] !== ic) {
                if (s[i] === "\\") {
                  inner += s[i];
                  i++;
                }
                if (i < n) {
                  inner += s[i];
                  i++;
                }
              }
              if (i < n) {
                inner += s[i];
                i++;
              }
              continue;
            }
            if (ic === "`") {
              inner += ic;
              i++;
              let nest = 0; // track ${ } nesting inside this nested template so its braces are balanced
              while (i < n) {
                if (s[i] === "\\") {
                  inner += s[i] + (s[i + 1] ?? "");
                  i += 2;
                  continue;
                }
                if (s[i] === "`" && nest === 0) {
                  inner += s[i];
                  i++;
                  break;
                }
                if (s[i] === "$" && s[i + 1] === "{") {
                  nest++;
                  inner += "${";
                  i += 2;
                  continue;
                }
                if (s[i] === "}" && nest > 0) {
                  nest--;
                  inner += "}";
                  i++;
                  continue;
                }
                inner += s[i];
                i++;
              }
              continue;
            }
            if (ic === "/" && isRegexStart(inner)) {
              inner += "/";
              i++;
              let inClass = false;
              while (i < n) {
                if (s[i] === "\\") {
                  inner += s[i] + (s[i + 1] ?? "");
                  i += 2;
                  continue;
                }
                if (s[i] === "[") inClass = true;
                else if (s[i] === "]") inClass = false;
                else if (s[i] === "/" && !inClass) {
                  inner += s[i];
                  i++;
                  break;
                }
                inner += s[i];
                i++;
              }
              continue;
            }
            if (ic === "{") {
              depth++;
              inner += ic;
              i++;
              continue;
            }
            if (ic === "}") {
              depth--;
              if (depth > 0) inner += ic;
              i++;
              continue;
            }
            inner += ic;
            i++;
          }
          out += `\${${codeOnly(inner).code}}`;
          continue;
        }
        i++; // ordinary template-literal char — drop it
      }
      out += "`"; // closing backtick (kept, so a template first-arg stays detectable)
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, inBlock: false };
}

function sinkLabel(match: string): string {
  return match.replace(/\s+/g, "").replace(/\($/, "");
}

/** Classify one stripped code view: does it write to a DOM-HTML sink or execute a dynamic-code sink? Returns the
 *  kind + a public-safe sink label, or null. Reports only the FIRST matching sink class on the line (brevity). */
function detectUnsafeDomInCode(
  code: string,
): { kind: UnsafeDomFinding["kind"]; sink: string } | null {
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
  if ((m = SET_TIMER_STRING_RE.exec(code)))
    return { kind: "set-timeout-string", sink: sinkLabel(m[0]) };
  return null;
}

/** Classify one line (single-line context: not inside a carried block comment). */
export function detectUnsafeDom(
  line: string,
): { kind: UnsafeDomFinding["kind"]; sink: string } | null {
  return detectUnsafeDomInCode(codeOnly(line).code);
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

/** Scan one file patch's added lines for unsafe DOM / code-execution sinks, line-cited via hunk headers. Block-
 *  comment state is carried across consecutive added lines (and reset at hunk/context/removed boundaries). Pure. */
export function scanPatchForUnsafeDom(
  path: string,
  patch: string,
  limits: UnsafeDomScanLimits = {},
): UnsafeDomFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const findings: UnsafeDomFinding[] = [];
  let newLine = 0;
  let inBlock = false; // inside an added multi-line /* */ comment
  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inBlock = false; // a new hunk is non-contiguous; do not carry comment state across it
      continue;
    }
    if (line.startsWith("+")) {
      const body = line.slice(1);
      const stripped = codeOnly(body, inBlock);
      inBlock = stripped.inBlock;
      if (body.length <= MAX_LINE_CHARS) {
        const hit = detectUnsafeDomInCode(stripped.code);
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
      // context line: it is part of the new file, so parse it for block-comment state (a `/* */` can open on a
      // context line and continue onto an added line) but never report findings on it.
      inBlock = codeOnly(line.slice(1), inBlock).inBlock;
      newLine++;
    }
    // a removed line is not part of the new file: skip it without advancing newLine or changing comment state.
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
