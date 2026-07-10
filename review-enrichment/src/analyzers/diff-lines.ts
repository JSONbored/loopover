/**
 * Shared unified-diff line helpers for analyzers that scan patch fragments which may or may not include hunk
 * headers (so they cannot rely on hunk state).
 */

/**
 * True only for a real unified-diff FILE HEADER — `+++ b/path`, `--- a/path`, or `+++ `/`--- /dev/null`
 * (marker run + space + an `a/`/`b/` prefix or `/dev/null`).
 *
 * This deliberately does NOT match added/removed CONTENT whose text begins with `++`/`--`: git renders an
 * added line whose content is `++x` as `+` + `++x` = `+++x`, and `++ x` as `+++ x`. An anchored
 * `startsWith("+++ ")` guard skips `+++ x` as if it were a header and drops the real added line; keying on the
 * header's path form scans that content while still skipping true headers.
 */
export function isDiffFileHeaderLine(line: string): boolean {
  return /^(?:\+\+\+|---) (?:[ab]\/|\/dev\/null)/.test(line);
}

/**
 * True for a line whose visible content opens with a `//` line comment, a `/* ` block-comment opener, or a
 * `*` block-comment continuation — the baseline "this added line is not real code" check shared by analyzers
 * that skip comment lines before pattern-matching (#4611).
 *
 * This is the common BASE only. `hardcoded-url.ts` and `a11y-regression.ts` each layer additional
 * language-specific comment forms on top of it (shell/Python `#`, HTML `<!--`, JSX-adjacent `import`/`from`)
 * via their own local `isCommentLine` override — those two are deliberately not folded in here, since e.g. a
 * `#` line-start is a real comment in Python but a real (and common) Markdown heading / hex-color / URL
 * fragment elsewhere, so it isn't a safe universal default.
 */
export function isBasicCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^(?:\/\/|\/\*|\*)/.test(trimmed);
}
