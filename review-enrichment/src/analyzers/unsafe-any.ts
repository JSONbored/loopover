// Unsafe `any` analyzer (#2017). Flags explicit `any` type usages INTRODUCED by the PR (added `+` diff lines) in
// TypeScript sources — a `: any` type annotation, an `as any` cast, or an `<any>` angle-bracket assertion. Each
// opts out of the type checker, and the no-checkout reviewer reading only the diff has to spot them by eye. Pure
// compute, structural regex only (no type-checker), never throws (fail-safe → []). Line-cited via hunk headers,
// mirroring the ReDoS analyzer's added-line scan.
import type { EnrichRequest, UnsafeAnyFinding } from "../types.js";

const MAX_FINDINGS = 25; // keep the brief bounded
const MAX_LINE_CHARS = 2000; // skip matching on pathologically long lines (defensive)

type UnsafeAnyScanLimits = {
  maxFindings?: number;
};

// Only hand-authored TypeScript is scanned; a generated declaration file (`.d.ts`) is excluded, matching the
// generated-output skips the sibling analyzers use.
const TS_SOURCE_RE = /\.tsx?$/;
const DECLARATION_RE = /\.d\.ts$/;

function isScannableTsFile(path: string): boolean {
  return TS_SOURCE_RE.test(path) && !DECLARATION_RE.test(path);
}

// The three explicit-`any` shapes, matched on an added line's CONTENT (the leading `+` already stripped):
//   - `annotation`: a `: any` type annotation. The `\bany\b` word boundary keeps `: anyThing` / `: many` from matching.
//   - `cast`: an `as any` assertion. The leading `\b` keeps `has any` from matching.
//   - `assertion`: an `<any>` angle-bracket type assertion (`<any>value`). The leading negative lookbehind
//     `(?<![\w$>])` requires the `<` NOT follow an identifier/`>`, so a GENERIC type argument (`Promise<any>`,
//     `Array<any>`, `foo<any>()`) is deliberately NOT reported here — labeling those "assertion" would be wrong (a
//     generic arg is not an assertion, and `<any>` assertions are not even legal syntax in `.tsx`). Missing them is
//     a fail-safe under-report, precision over recall.
const DETECTORS: ReadonlyArray<{
  kind: UnsafeAnyFinding["kind"];
  pattern: RegExp;
}> = [
  { kind: "annotation", pattern: /:\s*any\b/ },
  { kind: "cast", pattern: /\bas\s+any\b/ },
  { kind: "assertion", pattern: /(?<![\w$>])<\s*any\s*>/ },
];

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

// Best-effort string/comment avoidance — cheaply-detectable only, per the issue (NOT a full parser). A line whose
// trimmed content OPENS a comment (`//`, `/*`, or a `*` JSDoc continuation) is skipped entirely; then single-line
// string literals are blanked; then a trailing `// …` line-comment is stripped. Known scoped-out gaps (documented,
// all fail-safe under-reports or rare): a string continued across diff lines (multi-line template / trailing `\`)
// isn't reassembled, and regex literals aren't parsed.
function contentToScan(content: string): string | null {
  const trimmed = content.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  ) {
    return null;
  }
  // Cheap best-effort string-literal removal FIRST (before comment stripping, so a `//` inside a string can't
  // truncate the line): blank out `"…"` / `'…'` / `` `…` `` bodies (honoring `\`-escapes) so an `any` token inside
  // a string — e.g. `throw new Error("cast x as any")` — is never flagged. Not a full parser (a `` ` `` template
  // with a newline spans diff lines, which we don't reassemble); it only ever REMOVES text, so it stays fail-safe.
  const withoutStrings = content.replace(/(["'`])(?:\\.|(?!\1).)*?\1/g, "");
  const comment = withoutStrings.indexOf("//");
  return comment === -1 ? withoutStrings : withoutStrings.slice(0, comment);
}

/** Scan one file patch's added lines for explicit `any` usages, line-cited via hunk headers. One finding per matched
 *  line per kind. Pure. */
export function scanPatchForUnsafeAny(
  path: string,
  patch: string,
  limits: UnsafeAnyScanLimits = {},
): UnsafeAnyFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const findings: UnsafeAnyFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patchLines(patch)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Skip pre-hunk preamble (the file header lives there); inside a hunk `+++x`/`+++ x` is added content.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const content = line.slice(1);
      const scannable =
        content.length <= MAX_LINE_CHARS ? contentToScan(content) : null;
      if (scannable !== null) {
        for (const { kind, pattern } of DETECTORS) {
          if (pattern.test(scannable)) {
            findings.push({ file: path, line: newLine, kind });
            if (findings.length >= maxFindings) return findings;
          }
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line — do not advance the cursor
      // (same class as the redos / undocumented-export fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed `.ts`/`.tsx` file's added lines for explicit `any` usages. Pure. */
export async function scanUnsafeAny(
  req: EnrichRequest,
): Promise<UnsafeAnyFinding[]> {
  const findings: UnsafeAnyFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch || !isScannableTsFile(file.path)) continue;
    for (const finding of scanPatchForUnsafeAny(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
