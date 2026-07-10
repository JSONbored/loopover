// Visual-path classifier (reviewbot→gittensory convergence — visual capture port).
//
// PORTED VERBATIM from reviewbot's src/agents/gittensory/capabilities.ts `isVisualPath` (the three
// VISUAL_PATTERNS), with the first pattern's app-folder segment widened to a wildcard (#3611 follow-up) so it
// isn't gittensory-ui-only — see capture.ts's DEFAULT_ROUTE_FILE for the same generalization. This is the
// EMPHATIC gate: screenshots fire ONLY for WEB-VISIBLE changes — any frontend app folder (apps/*/**, e.g.
// apps/gittensory-ui/** or apps/ui/**), a public asset (public/**, e.g. an OG image), or a front-of-house
// source extension (.tsx/.jsx/.css/.scss/.sass/.less/.html/.svg/.astro/.vue/.svelte/.mdx). A backend change
// (.ts/.md/.json/.py/...) matches NONE of these, so capture never triggers for it.
//
// PURE — no imports, no I/O. Callers MUST filter changed files through this before any capture.

const VISUAL_PATTERNS: RegExp[] = [
  /^apps\/[^/]+\//i,
  /(^|\/)public\//i,
  /\.(tsx|jsx|css|scss|sass|less|html|svg|astro|vue|svelte|mdx)$/i,
];

/** True when `path` is a web-visible change worth screenshotting (frontend page / public OG asset / front-end
 *  source file). Backend .ts/.md/.json/.py paths return false → capture must NOT trigger for them. */
export function isVisualPath(path: string): boolean {
  return VISUAL_PATTERNS.some((pattern) => pattern.test(path));
}
