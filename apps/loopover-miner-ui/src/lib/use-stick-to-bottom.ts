import { useEffect, useRef, type RefObject } from "react";

/** Within this many px of the bottom still counts as "at the bottom" for the auto-follow (#7229). */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 24;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= STICK_TO_BOTTOM_THRESHOLD_PX;
}

/**
 * Keep a ui-kit `ScrollArea` pinned to its newest content as that content grows — but only while the operator
 * is already at (or within {@link STICK_TO_BOTTOM_THRESHOLD_PX} of) the bottom. If they scroll up to re-read
 * history, the auto-follow suppresses itself until they return to the bottom, the well-worn chat-rail pattern
 * (#7229): a new committed message or a live streaming answer must never yank a deliberately-scrolled reader
 * back down.
 *
 * `rootRef` points at the `ScrollArea` *Root* (what its `ref` forwards to). The actual scrollable node is Radix's
 * viewport, resolved here via the `[data-radix-scroll-area-viewport]` attribute the primitive sets — so this never
 * depends on the shared ui-kit component exposing a viewport ref of its own.
 */
export function useStickToBottom(rootRef: RefObject<HTMLElement | null>): void {
  // Was the viewport at the bottom just *before* the latest content mutation? Seeded true so an already-
  // overflowing conversation opens scrolled to the newest turn; recomputed on every scroll so that once the
  // operator scrolls up the follow stays suppressed until they scroll back down.
  const pinnedRef = useRef(true);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!viewport) return;

    const onScroll = () => {
      pinnedRef.current = isNearBottom(viewport);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    const followIfPinned = () => {
      if (pinnedRef.current) viewport.scrollTop = viewport.scrollHeight;
    };

    // One observer covers both triggers: a committed message adds an <li> (childList) and a streaming chunk
    // rewrites StreamingText's text (characterData) — both are mutations under the viewport, so neither the
    // new-message case nor the live-streaming case is special-cased.
    const observer = new MutationObserver(followIfPinned);
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });

    // Snap to the bottom once on mount so a conversation that is already past the fold opens on its newest turn.
    followIfPinned();

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [rootRef]);
}
