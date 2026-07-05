// Generic marker-block refresh (#3004, part of the repo-doc generation roadmap #2993). A single, reusable
// mechanism for "recompute the machine-generated section of a file, leave everything outside it byte-for-byte
// untouched" -- used today by AGENTS.md/CLAUDE.md (src/github/repo-doc-pr.ts, src/review/repo-doc-render.ts)
// and meant to be reused UNCHANGED by any future generated skill file (#3001) and by the scheduled-refresh
// no-meaningful-change check (#3003), so those features never grow a second, divergent diff implementation.
//
// FAILS CLOSED ON A MISSING/ALTERED MARKER BLOCK: an existing file with no marker block at all, or a malformed
// one (missing start/end, duplicated, or out of order), is NEVER silently overwritten -- refresh returns
// `manual-review-required` instead of guessing which part of the file is safe to replace. This is what lets a
// maintainer's hand-written content survive: anything outside a valid marker block is preserved verbatim, and
// anything that no longer LOOKS like a valid marker block halts automation rather than clobbering it.

export type GeneratedDocMarkers = { start: string; end: string };

export type GeneratedDocRefreshResult =
  | { action: "generate"; content: string }
  | { action: "replace"; content: string }
  | { action: "no-change" }
  | { action: "manual-review-required"; reason: string };

type MarkerBlock = { startIndex: number; endIndex: number };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function findMarkerBlock(content: string, markers: GeneratedDocMarkers): MarkerBlock | { error: string } {
  const startCount = countOccurrences(content, markers.start);
  const endCount = countOccurrences(content, markers.end);
  if (startCount === 0 && endCount === 0) return { error: "no generated-content marker block found" };
  if (startCount !== 1) return { error: `expected exactly one start marker, found ${startCount}` };
  if (endCount !== 1) return { error: `expected exactly one end marker, found ${endCount}` };
  const startIndex = content.indexOf(markers.start);
  // A renderer's own output (e.g. renderRepoDocContent) always ends with `${end marker}\n` -- one trailing
  // newline is considered PART of the generated section, not "after" content. Consuming it here too keeps a
  // freshly re-extracted `currentSection` byte-identical to a freshly rendered `generatedSection` when nothing
  // actually changed; without it, `no-change` could never fire for any real renderer output.
  let endIndex = content.indexOf(markers.end) + markers.end.length;
  if (content[endIndex] === "\n") endIndex += 1;
  if (endIndex <= startIndex + markers.start.length) return { error: "end marker appears before (or immediately at) the start marker" };
  return { startIndex, endIndex };
}

/**
 * Recompute the machine-generated section of a file. `generatedSection` MUST already carry the `markers.start`/
 * `markers.end` pair. Most renderers put the start marker at byte 0; skill files may put required YAML
 * frontmatter before the marker, and that generated prefix is replaced together with the marked span.
 *
 * - `currentContent === null` (no file exists yet): `generate` -- content is exactly `generatedSection`.
 * - A valid, single marker block is found and its current text already equals `generatedSection`: `no-change`
 *   -- callers (including the future scheduled-refresh check, #3003) use this to skip opening a no-op PR.
 * - A valid, single marker block is found and differs: `replace` -- `content` preserves everything outside
 *   the generated section byte-for-byte, substituting the generated prefix (if any) plus the marked span.
 * - No marker block, or a malformed one (missing start/end, duplicated, or end-before-start): `manual-review-
 *   required` -- an existing file that doesn't unambiguously look machine-generated is never touched.
 */
export function refreshGeneratedDoc(currentContent: string | null, generatedSection: string, markers: GeneratedDocMarkers): GeneratedDocRefreshResult {
  if (currentContent === null) return { action: "generate", content: generatedSection };
  const block = findMarkerBlock(currentContent, markers);
  if ("error" in block) return { action: "manual-review-required", reason: block.error };
  const generatedStartIndex = generatedSection.indexOf(markers.start);
  if (generatedStartIndex === -1) return { action: "manual-review-required", reason: "generated section is missing the start marker" };
  const replacementStart = Math.max(0, block.startIndex - generatedStartIndex);
  const currentSection = currentContent.slice(replacementStart, block.endIndex);
  if (currentSection === generatedSection) return { action: "no-change" };
  const before = currentContent.slice(0, replacementStart);
  const after = currentContent.slice(block.endIndex);
  return { action: "replace", content: `${before}${generatedSection}${after}` };
}
