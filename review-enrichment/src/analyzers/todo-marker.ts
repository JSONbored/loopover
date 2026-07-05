// TODO/FIXME/HACK/XXX marker tracker (#2016). Surfaces known-incomplete-work markers a PR ADDS, with the tag,
// the file:line, and a truncated note — so a reviewer sees the change is shipping acknowledged-incomplete work.
// Pure compute over added lines, no network. Stateless per line — there is no multi-line comment/string state to
// track. Precision-first, false-negative-biased: a marker is reported ONLY when (a) it is UPPERCASE (the marker
// convention — a lowercase `todo` identifier is never flagged) AND (b) it is COMMENT-ANCHORED, i.e. immediately
// preceded on the same line by a comment lead-in (`//`, `#`, `/*`, `*`, `<!--`). String literals are blanked
// first (via secret-log's codeOnly), so a `"// TODO"` inside a string is not a hit. A bare marker inside a
// multi-line block comment whose opener is on a previous line (` TODO` with no lead-in on its own line) is
// deliberately NOT matched — missing it is the safe direction, and the common `* TODO` continuation form still
// anchors on the leading `*`. Line-cited via hunk headers, mirroring the sibling local analyzers.
import type { EnrichRequest, TodoMarkerFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;
const MAX_NOTE_CHARS = 120;

// A comment lead-in followed by an UPPERCASE tag as a whole word, then an optional separator and the note.
// Case-SENSITIVE on the tag so a lowercase `todo`/`fixme` identifier never matches. Two lead-in shapes, each
// requiring a token boundary so an operator is not mistaken for a comment:
//   • `//` `#` `/*` `<!--` at start-of-line or after whitespace — unambiguous comment starts. The boundary keeps
//     `this.#TODO` (a private field: `.` precedes `#`) and `foo();//X` (no space) out; `x; // TODO` is in.
//   • a bare `*` only at the START of the trimmed line — the JSDoc `* TODO` continuation. Restricting it to
//     line-start keeps a multiplication like `base * TODO` (a `*` mid-expression) from ever matching.
// The alternations are flat (linear-time). `\b` after the tag keeps `TODOS`/`XXXL` out.
const MARKER_RE =
  /(?:(?:^|\s)(?:\/\/|#|\/\*|<!--)|^\s*\*)\s*(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/;

/** Trim a captured note: drop a trailing block-comment/HTML close and surrounding whitespace, then truncate. */
function cleanNote(raw: string): string {
  const trimmed = raw.replace(/\s*(?:\*\/|-->)\s*$/, "").trim();
  return trimmed.length > MAX_NOTE_CHARS ? trimmed.slice(0, MAX_NOTE_CHARS) : trimmed;
}

/** Detect a comment-anchored uppercase marker on one line. Returns the tag + optional note, or null. Pure. */
export function detectTodoMarker(
  line: string,
): { tag: TodoMarkerFinding["tag"]; note?: string } | null {
  const match = MARKER_RE.exec(codeOnly(line));
  if (!match) return null;
  const tag = match[1] as TodoMarkerFinding["tag"];
  const note = cleanNote(match[2] ?? "");
  return note ? { tag, note } : { tag };
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch's added lines for comment-anchored markers, line-cited via hunk headers. Pure. */
export function scanPatchForTodoMarker(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): TodoMarkerFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const findings: TodoMarkerFinding[] = [];
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
        const hit = detectTodoMarker(body);
        if (hit) {
          findings.push(
            hit.note
              ? { file: path, line: newLine, tag: hit.tag, note: hit.note }
              : { file: path, line: newLine, tag: hit.tag },
          );
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line — do not advance the cursor
      // (same class as the actions-pin / secret-log fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's added lines for newly-added incomplete-work markers. */
export async function scanTodoMarker(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<TodoMarkerFinding[]> {
  const findings: TodoMarkerFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForTodoMarker(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
