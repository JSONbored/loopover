import { describe, expect, it } from "vitest";
import { CHAT_NEAR_BOTTOM_PX, isChatViewportNearBottom, scrollChatViewportToBottom } from "./chat-scroll";

// Pure-logic coverage for the stick-to-bottom auto-scroll math (#7793), following the one-test-per-pure-module
// convention demo-data.test.ts establishes in this directory. jsdom doesn't meaningfully simulate a real
// viewport's scrollTop/scrollHeight, so these drive the exported functions directly with plain metric objects.

/** A minimal viewport stand-in carrying just the three metrics isChatViewportNearBottom reads. */
function viewport(scrollTop: number, scrollHeight: number, clientHeight: number) {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("isChatViewportNearBottom (#7793)", () => {
  it("is true when the viewport is scrolled to the very bottom (distance 0)", () => {
    // scrollHeight - scrollTop - clientHeight === 0 <= 80
    expect(isChatViewportNearBottom(viewport(900, 1000, 100))).toBe(true);
  });

  it("is true exactly at the CHAT_NEAR_BOTTOM_PX boundary (distance === threshold)", () => {
    // distance = 1000 - 820 - 100 = 80, which is <= 80 -> still "pinned".
    expect(isChatViewportNearBottom(viewport(820, 1000, 100))).toBe(true);
  });

  it("is false one pixel past the boundary (distance === threshold + 1)", () => {
    // distance = 1000 - 819 - 100 = 81, which is > 80 -> no longer pinned.
    expect(isChatViewportNearBottom(viewport(819, 1000, 100))).toBe(false);
  });

  it("is false when scrolled well up from the bottom", () => {
    // distance = 1000 - 0 - 100 = 900 > 80
    expect(isChatViewportNearBottom(viewport(0, 1000, 100))).toBe(false);
  });

  it("treats short content (viewport taller than content) as near the bottom", () => {
    // distance = 100 - 0 - 500 = -400 <= 80 -> a non-scrollable short chat is always "pinned".
    expect(isChatViewportNearBottom(viewport(0, 100, 500))).toBe(true);
  });

  it("honors a custom threshold over the default CHAT_NEAR_BOTTOM_PX", () => {
    // distance = 1000 - 950 - 100 = -50; with a tiny threshold of 0 that's still <= 0 -> true...
    expect(isChatViewportNearBottom(viewport(950, 1000, 100), 0)).toBe(true);
    // ...and a distance of 10 exceeds a threshold of 5 -> false, proving the arg is actually used.
    expect(isChatViewportNearBottom(viewport(890, 1000, 100), 5)).toBe(false);
  });

  it("exports the documented 80px default threshold", () => {
    expect(CHAT_NEAR_BOTTOM_PX).toBe(80);
  });
});

describe("scrollChatViewportToBottom (#7793)", () => {
  it("sets scrollTop to scrollHeight - clientHeight for scrollable content", () => {
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 } as HTMLElement;
    scrollChatViewportToBottom(el);
    expect(el.scrollTop).toBe(900);
  });

  it("clamps to 0 when the content is shorter than the viewport (never negative)", () => {
    // scrollHeight - clientHeight = 100 - 500 = -400 -> Math.max(0, ...) pins it at 0.
    const el = { scrollTop: 42, scrollHeight: 100, clientHeight: 500 } as HTMLElement;
    scrollChatViewportToBottom(el);
    expect(el.scrollTop).toBe(0);
  });
});
