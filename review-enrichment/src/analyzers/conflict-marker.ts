// Leftover VCS conflict-marker analyzer (#2032). Flags merge/rebase conflict markers accidentally committed in
// the ADDED lines of a PR diff — `<<<<<<<` (ours), `|||||||` (diff3 base), `=======` (separator), `>>>>>>>`
// (theirs) — a mechanical, near-zero-false-positive catch that should block a merge. Pure compute, no network.
// Detection is purely structural (a fixed run of seven identical characters at column 0), so there is no
// comment/string state to track. Line-cited via hunk headers, mirroring the sibling local analyzers.
import type { EnrichRequest, ConflictMarkerFinding } from "../types.js";

const MAX_FINDINGS = 25;

// Git writes each conflict marker as EXACTLY seven identical characters at the start of the line. The ours/base/
// theirs markers may carry a trailing space + label (a branch or commit); the separator is a bare seven `=`.
// Requiring exactly seven (not six, not eight) keeps a run of `<`/`|`/`>` unambiguous — seven of those at column
// 0 is never valid prose or code.
const OURS_RE = /^<{7}(?: .*)?$/;
const BASE_RE = /^\|{7}(?: .*)?$/;
const THEIRS_RE = /^>{7}(?: .*)?$/;
const SEPARATOR_RE = /^={7}$/;

// A bare `=======` line is legitimate markup: a Markdown setext-H1 underline and an AsciiDoc section rule both
// use it. So the ambiguous separator is NOT flagged in markup files — but the unambiguous `<<<<<<<`/`|||||||`/
// `>>>>>>>` markers still are, so a real conflict landing in a Markdown file is caught by those.
const MARKUP_PATH_RE = /\.(?:md|markdown|mdx|rst|adoc|asciidoc|textile)$/i;

/** Classify one line's conflict-marker shape, or null. `allowSeparator` is false in markup files. Pure. */
export function conflictMarkerOf(
  line: string,
  allowSeparator: boolean,
): ConflictMarkerFinding["marker"] | null {
  if (OURS_RE.test(line)) return "<<<<<<<";
  if (BASE_RE.test(line)) return "|||||||";
  if (THEIRS_RE.test(line)) return ">>>>>>>";
  if (allowSeparator && SEPARATOR_RE.test(line)) return "=======";
  return null;
}

/** Scan one file's unified-diff patch for conflict markers on added lines, line-cited via hunk headers. Pure. */
export function scanPatchForConflictMarkers(
  path: string,
  patch: string,
  maxFindings: number = MAX_FINDINGS,
): ConflictMarkerFinding[] {
  const findings: ConflictMarkerFinding[] = [];
  if (maxFindings <= 0) return findings;
  const allowSeparator = !MARKUP_PATH_RE.test(path);
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Skip the pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const marker = conflictMarkerOf(line.slice(1), allowSeparator);
      if (marker) {
        findings.push({ file: path, line: newLine, marker });
        if (findings.length >= maxFindings) return findings;
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A context line advances the new-file cursor; a removed line and a `\ No newline at end of file`
      // marker do not (same class as the actions-pin / iac-misconfig line-number fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's patch for leftover conflict markers. Pure, no network. */
export async function scanConflictMarkers(
  req: EnrichRequest,
): Promise<ConflictMarkerFinding[]> {
  const findings: ConflictMarkerFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch) continue;
    for (const finding of scanPatchForConflictMarkers(
      file.path,
      file.patch,
      MAX_FINDINGS - findings.length,
    )) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
