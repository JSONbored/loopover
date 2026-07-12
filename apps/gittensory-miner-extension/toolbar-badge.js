// Toolbar-icon badge state (#5193). A pure map from the raw `rankedCandidates` value in chrome.storage.local to
// the toolbar badge's { text, backgroundColor }. It distinguishes THREE states so "no data yet" is never
// confused with "zero opportunities":
//   • never populated (no key ever written ⇒ value is `undefined`, or any malformed non-array) → a dash, NEVER a count
//   • populated but empty (`[]`)                                                                 → cleared text
//   • populated (`[…]`)                                                                          → the count
// Read-only: it computes values only; the background service worker applies them via chrome.action.
export const TOOLBAR_BADGE_HAS_DATA_COLOR = "#16a34a";
export const TOOLBAR_BADGE_EMPTY_COLOR = "#6b7280";
// The no-data indicator (a dash, never a numeric count). A named constant so source and tests can never drift.
export const TOOLBAR_BADGE_NO_DATA_TEXT = "–";

/**
 * @param {unknown} rankedCandidates the raw `chrome.storage.local` value (read WITHOUT a default, so `undefined`
 *   genuinely means the key has never been written).
 * @returns {{ text: string, backgroundColor: string }}
 */
export function computeToolbarBadge(rankedCandidates) {
  if (Array.isArray(rankedCandidates)) {
    return rankedCandidates.length > 0
      ? {
          text: String(rankedCandidates.length),
          backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
        }
      : { text: "", backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR };
  }
  // undefined (never populated) or a malformed non-array value → show a dash, never a numeric count.
  return {
    text: TOOLBAR_BADGE_NO_DATA_TEXT,
    backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
  };
}

// Expose on a global too — the background service worker reads this the same way it reads
// `__gittensoryMinerOpportunityBadge`, so the extension's VM-based test harness (which cannot evaluate ESM
// `import` bindings) can drive it without a module loader.
globalThis.__gittensoryMinerToolbarBadge = {
  computeToolbarBadge,
  TOOLBAR_BADGE_HAS_DATA_COLOR,
  TOOLBAR_BADGE_EMPTY_COLOR,
  TOOLBAR_BADGE_NO_DATA_TEXT,
};
