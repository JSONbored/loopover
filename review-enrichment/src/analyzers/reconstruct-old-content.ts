// Shared unified-diff reverse-patch reconstruction (#4739, part of epic #4737). Originally private to
// doc-comment-drift.ts (#1519) and imported cross-file from there by exhaustiveness-drift.ts (#2028) — a
// one-off trick living in the wrong place rather than shared infrastructure. Promoted here, unchanged in
// behavior, so any analyzer can recover a changed file's pre-PR text without re-deriving this.
//
// Cost note: this function does no I/O. The caller must already have fetched the file's post-change
// (`headSha`) content — the same authed GitHub contents-API fetch every current caller already performs
// for its own purposes — and pass it in as `newContent`. Promoting the reverse-patch algorithm out of
// doc-comment-drift.ts does not add a new network call.
//
// Binary files: this function only ever sees two text blobs (`newContent`, `patch`) and has no file path
// or extension to inspect, so it cannot itself detect a binary file. That filtering happens one layer up:
// every current caller only invokes this after confirming the file's patch is present and its path
// matches a known source extension (GitHub omits `.patch` entirely for binary/oversized files, so a
// binary path never reaches here in practice). A future caller must keep doing that same source/extension
// filtering before calling this — it is not this function's job to guess from content alone.

/** Reconstruct the pre-PR content of a file by reverse-applying its unified `patch` to the post-PR
 *  `newContent`: context and removed (`-`) lines rebuild the old text; added (`+`) lines are dropped.
 *
 *  Returns `null` when the patch cannot be reverse-applied against the given `newContent` — a hunk starts
 *  before the cursor or past the end of the content, or an added/context line doesn't match `newContent`
 *  at the expected position (a malformed/truncated patch, or a `newContent` that doesn't correspond to
 *  the same ref the patch was computed against).
 *
 *  Returns an empty string when the patch reverse-applies cleanly but yields zero pre-PR lines — the case
 *  for a file that did not exist before this PR (a "wholly added" patch has no old-side content to
 *  rebuild). An empty string and `null` are both falsy; every caller should treat either as "no usable
 *  before-content for this file" via a plain truthiness check (`if (!beforeContent) …`), not a strict
 *  `=== null` comparison — the two are operationally the same "nothing to compare against" outcome, and
 *  patch data alone cannot (and need not) distinguish a brand-new file from a pre-existing 0-byte one.
 *
 *  Pure — no I/O, no dependency on `path` or any other file metadata. */
export function reconstructOldContent(newContent: string, patch: string): string | null {
  const newLines = newContent.split("\n");
  const patchLines = patch.split("\n");
  const out: string[] = [];
  let cursor = 0; // next unconsumed index into newLines
  let i = 0;
  while (i < patchLines.length) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(patchLines[i]!);
    if (!header) {
      i += 1;
      continue;
    }
    const hunkStart = Number(header[1]) - 1; // 0-based new-file line the hunk begins at
    if (hunkStart < cursor || hunkStart > newLines.length) return null;
    while (cursor < hunkStart) out.push(newLines[cursor++]!); // unchanged lines before the hunk
    i += 1;
    while (i < patchLines.length && !patchLines[i]!.startsWith("@@")) {
      const l = patchLines[i]!;
      if (!l.startsWith("\\")) {
        const sign = l[0];
        const body = l.slice(1);
        if (sign === "-") {
          out.push(body); // removed: present in old only
        } else {
          // added or context lines must match the fetched head content at the cursor; a mismatch means the patch
          // doesn't align with `newContent` (malformed/truncated input, or a different ref) → bail so we never
          // trust a reconstructed result that isn't provably faithful to the real pre-PR file.
          if (newLines[cursor] !== body) return null;
          if (sign !== "+") out.push(body); // context is present in old too; an added line is not
          cursor += 1;
        }
      }
      i += 1;
    }
  }
  while (cursor < newLines.length) out.push(newLines[cursor++]!);
  return out.join("\n");
}
