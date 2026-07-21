import { describe, expect, it } from "vitest";
import { CHAT_NEAR_BOTTOM_PX, isChatViewportNearBottom, scrollChatViewportToBottom } from "./chat-scroll";

/** A minimal stand-in for the scroll viewport: jsdom can't set scrollHeight/clientHeight on a real element. */
function viewport(scrollHeight: number, clientHeight: number, scrollTop = 0): HTMLElement {
  return { scrollTop, scrollHeight, clientHeight } as unknown as HTMLElement;
}

describe("isChatViewportNearBottom (#7229)", () => {
  it("treats a distance of exactly CHAT_NEAR_BOTTOM_PX as still pinned (the <= boundary)", () => {
    // scrollHeight - scrollTop - clientHeight === 80
    expect(isChatViewportNearBottom(viewport(1000, 400, 520))).toBe(true);
  });

  it("treats one pixel past the threshold as scrolled away", () => {
    // ...=== 81
    expect(isChatViewportNearBottom(viewport(1000, 400, 519))).toBe(false);
  });

  it("is true when the viewport sits exactly at the bottom", () => {
    expect(isChatViewportNearBottom(viewport(1000, 400, 600))).toBe(true);
  });

  it("is true for content shorter than the viewport (negative distance, nothing to scroll)", () => {
    expect(isChatViewportNearBottom(viewport(200, 400, 0))).toBe(true);
  });

  it("is false when scrolled far up", () => {
    expect(isChatViewportNearBottom(viewport(5000, 400, 0))).toBe(false);
  });

  it("honors an explicit thresholdPx instead of the default", () => {
    // distance === 10: outside a 0px threshold, inside the 80px default.
    expect(isChatViewportNearBottom(viewport(1000, 400, 590), 0)).toBe(false);
    expect(isChatViewportNearBottom(viewport(1000, 400, 590))).toBe(true);
    // distance === 0 still counts at a 0px threshold (<=, not <).
    expect(isChatViewportNearBottom(viewport(1000, 400, 600), 0)).toBe(true);
  });

  it("exposes the documented 80px threshold", () => {
    expect(CHAT_NEAR_BOTTOM_PX).toBe(80);
  });
});

describe("scrollChatViewportToBottom (#7229)", () => {
  it("scrolls to the maximum scrollable offset", () => {
    const el = viewport(1000, 400, 0);
    scrollChatViewportToBottom(el);
    expect(el.scrollTop).toBe(600);
  });

  it("clamps to 0 when the content is shorter than the viewport", () => {
    const el = viewport(200, 400, 25);
    scrollChatViewportToBottom(el);
    expect(el.scrollTop).toBe(0);
  });

  it("leaves an already-bottomed viewport at the same offset (idempotent)", () => {
    const el = viewport(1000, 400, 600);
    scrollChatViewportToBottom(el);
    expect(el.scrollTop).toBe(600);
  });
});
