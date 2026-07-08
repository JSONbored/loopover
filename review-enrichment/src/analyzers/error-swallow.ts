// Empty-catch / error-swallow analyzer (#2014, extended for Go + Python bare-except by #1477). Flags
// newly-added catch/except blocks (and Go `if err != nil` checks) that swallow or mishandle the error — empty
// body, unused binding, a bare `return null`/`nil`, or (Python-only) a bare `except:` naming no exception type,
// which catches everything (including SystemExit/KeyboardInterrupt) regardless of its body — all top sources
// of silent failures. Pure compute over added diff lines, no network. Scoped to JS/TS/Python/Go source files.
import type { EnrichRequest, ErrorSwallowFinding } from "../types.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "go"]);

const CATCH_OPEN_RE = /catch\s*(?:\(\s*([\w$]+)?\s*\))?\s*\{/;
// Go's `if err != nil { ... }` check, in both its bare form (`if err != nil {`) and its very common
// if-with-initializer form (`if err := f(); err != nil {`, where only the text after the `;` is the actual
// check). The captured identifier must itself look like an error variable (contains "err"/"error",
// case-insensitively on the leading letter) so an unrelated nil-pointer check like `if node != nil {` is never
// mistaken for error handling. Parens are deliberately NOT part of the match: JS/TS require parens around an
// `if` condition and Go idiomatic (gofmt) style never adds them, so this shape cannot occur in valid JS/TS.
const GO_ERR_CHECK_OPEN_RE = /(?:\bif\s+|;\s*)(\w*[Ee]rr(?:or)?\d*)\s*!=\s*nil\s*\{/;
const OPEN_RES: RegExp[] = [CATCH_OPEN_RE, GO_ERR_CHECK_OPEN_RE];
const PY_EXCEPT_PASS_RE = /^\s*except(?:\s+[\w.]+\s*(?:as\s+(\w+))?)?\s*:\s*pass\s*(?:#.*)?$/;
// A bare Python `except:` naming no exception type at all — flake8's E722. This is a defect independent of the
// handler body (which may log or re-raise perfectly well): a bare except also catches SystemExit,
// KeyboardInterrupt, and GeneratorExit, which should almost never be swallowed alongside ordinary exceptions.
// Anchored so `except Exception:` / `except (A, B):` (a real type named) never match.
const PY_BARE_EXCEPT_RE = /^\s*except\s*:\s*(?:#.*)?$/;

/** Try each recognized error-handling opener (JS/TS `catch`, Go `if err != nil`) against `line`, in order.
 *  Returns the first match, with the checked/bound identifier always in capture group 1. Pure. */
function matchErrorOpen(line: string): RegExpExecArray | null {
  for (const re of OPEN_RES) {
    const match = re.exec(line);
    if (match) return match;
  }
  return null;
}

function isScannablePath(path: string): boolean {
  const ext = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  return Boolean(ext && SOURCE_EXTS.has(ext) && !isTestPath(path));
}

function escapeRegExp(value: string): string {
  return value.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");
}

function referencesBinding(body: string, binding: string): boolean {
  const escaped = escapeRegExp(binding);
  const bindingRe = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
  return bindingRe.test(body);
}

function bodySwallowsError(body: string, binding: string | null): ErrorSwallowFinding["kind"] | null {
  const trimmed = body.trim();
  if (!trimmed) return "empty-catch";
  // `null` covers JS/TS; `nil` covers the Go equivalent (Go has no `null` literal).
  if (/^return\s+(?:null|nil)\s*;?$/.test(trimmed)) return "return-null";
  if (!binding) return null;
  if (/\bthrow\b/.test(trimmed)) return null;
  // Go's `panic(err)` re-escalates rather than swallowing, the same role `throw` plays in JS/TS.
  if (/\bpanic\s*\(/.test(trimmed)) return null;
  if (/\b(?:console|logger|log|winston|pino|bunyan)\s*[.(]/.test(trimmed)) return null;
  if (/\bprint\s*\(/.test(trimmed)) return null;
  if (!referencesBinding(trimmed, binding)) return "unused-binding";
  return null;
}

function braceBalanceFrom(line: string, openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

/** Extract a complete error-handling block (JS/TS `catch`, or Go `if err != nil`) from one line using brace
 *  balance, or null if incomplete. Pure. */
export function parseCompleteCatchLine(
  line: string,
): { binding: string | null; body: string } | null {
  const open = matchErrorOpen(line);
  if (!open) return null;
  const braceStart = line.indexOf("{", open.index ?? 0);
  if (braceStart < 0) return null;

  let depth = 0;
  for (let i = braceStart; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      return {
        binding: open[1] ?? null,
        body: line.slice(braceStart + 1, i),
      };
    }
  }
  return null;
}

/** Classify one source line for an error-swallow / error-mishandling pattern, or null. Pure. */
export function detectErrorSwallow(line: string): ErrorSwallowFinding["kind"] | null {
  const pyMatch = PY_EXCEPT_PASS_RE.exec(line);
  if (pyMatch) {
    return pyMatch[1] ? "unused-binding" : "empty-catch";
  }
  if (PY_BARE_EXCEPT_RE.test(line)) return "bare-except";

  const complete = parseCompleteCatchLine(line);
  if (complete) {
    return bodySwallowsError(complete.body, complete.binding);
  }

  return null;
}

type PendingCatch = {
  startLine: number;
  binding: string | null;
  body: string;
  depth: number;
};

function updatePending(pending: PendingCatch, line: string): PendingCatch {
  let depth = pending.depth;
  for (const ch of line) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return { ...pending, body: `${pending.body}\n${line}`, depth };
}

function flushPending(pending: PendingCatch): ErrorSwallowFinding["kind"] | null {
  const body = pending.body.replace(/^\s*\{/, "").replace(/\}\s*$/, "");
  return bodySwallowsError(body, pending.binding);
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for swallowed errors, line-cited via hunk headers. Pure. */
export function scanPatchForErrorSwallow(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): ErrorSwallowFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isScannablePath(path)) return [];
  const findings: ErrorSwallowFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  let pending: PendingCatch | null = null;

  const pushFinding = (line: number, kind: ErrorSwallowFinding["kind"]) => {
    findings.push({ file: path, line, kind });
  };

  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      pending = null;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        if (pending) {
          pending = updatePending(pending, body);
          if (pending.depth <= 0) {
            const kind = flushPending(pending);
            if (kind) {
              pushFinding(pending.startLine, kind);
              if (findings.length >= maxFindings) return findings;
            }
            pending = null;
          }
        } else {
          const kind = detectErrorSwallow(body);
          if (kind) {
            pushFinding(newLine, kind);
            if (findings.length >= maxFindings) return findings;
          } else {
            const open = matchErrorOpen(body);
            if (open) {
              const braceIndex = body.indexOf("{", open.index ?? 0);
              if (braceIndex >= 0) {
                const depth = braceBalanceFrom(body, braceIndex);
                if (depth > 0) {
                  pending = {
                    startLine: newLine,
                    binding: open[1] ?? null,
                    body: body.slice(braceIndex),
                    depth,
                  };
                }
              }
            }
          }
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      pending = null;
      newLine++;
    } else {
      pending = null;
    }

    if (findings.length >= maxFindings) return findings;
  }

  return findings;
}

/** Analyzer entrypoint: scan every changed scannable file's added lines for swallowed errors. */
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
