export declare const TOOLBAR_BADGE_HAS_DATA_COLOR: string;
export declare const TOOLBAR_BADGE_EMPTY_COLOR: string;
export declare const TOOLBAR_BADGE_NO_DATA_TEXT: string;

/** Map the raw `chrome.storage.local` `rankedCandidates` value to the toolbar badge's text + background color. */
export declare function computeToolbarBadge(rankedCandidates: unknown): {
  text: string;
  backgroundColor: string;
};
