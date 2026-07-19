import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { STICK_TO_BOTTOM_THRESHOLD_PX, useStickToBottom } from "./lib/use-stick-to-bottom";

// A minimal stand-in for ui-kit's ScrollArea DOM: a Root wrapping the Radix viewport node (the one carrying
// the `[data-radix-scroll-area-viewport]` attribute the hook resolves against) wrapping a content node.
function makeScrollArea(): { root: HTMLDivElement; viewport: HTMLDivElement; content: HTMLDivElement } {
  const root = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.setAttribute("data-radix-scroll-area-viewport", "");
  const content = document.createElement("div");
  viewport.appendChild(content);
  root.appendChild(viewport);
  document.body.appendChild(root);
  return { root, viewport, content };
}

// jsdom does not lay out, so scrollHeight/clientHeight are 0 unless overridden; scrollTop is a real
// writable/readable property (unclamped), which is what the hook writes and the assertions read.
function setDims(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

/** Flush the MutationObserver microtask so its follow callback has run. */
const flushObserver = () => new Promise((resolve) => setTimeout(resolve, 0));

function grow(viewport: HTMLElement): void {
  viewport.appendChild(document.createElement("p"));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useStickToBottom (#7229)", () => {
  it("follows content to the bottom when the viewport is already at the bottom", async () => {
    const { root, viewport } = makeScrollArea();
    renderHook(() => useStickToBottom({ current: root }));
    setDims(viewport, 1000, 200);

    grow(viewport);
    await flushObserver();

    expect(viewport.scrollTop).toBe(1000);
  });

  it("does NOT follow when the operator has scrolled up to read history", async () => {
    const { root, viewport } = makeScrollArea();
    renderHook(() => useStickToBottom({ current: root }));
    setDims(viewport, 1000, 200);

    // Scroll well away from the bottom (gap 800 > threshold) and announce it — the follow must now stay off.
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));

    grow(viewport);
    await flushObserver();

    expect(viewport.scrollTop).toBe(0);
  });

  it("resumes following once the operator returns to within the bottom threshold", async () => {
    const { root, viewport } = makeScrollArea();
    renderHook(() => useStickToBottom({ current: root }));
    setDims(viewport, 1000, 200);

    // First scroll up so the follow is suppressed...
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    // ...then scroll back to within the threshold of the bottom (gap 10 <= 24) — the follow re-arms.
    viewport.scrollTop = 1000 - 200 - (STICK_TO_BOTTOM_THRESHOLD_PX - 14);
    viewport.dispatchEvent(new Event("scroll"));

    grow(viewport);
    await flushObserver();

    expect(viewport.scrollTop).toBe(1000);
  });

  it("stops following after unmount (listener + observer are torn down)", async () => {
    const { root, viewport } = makeScrollArea();
    const { unmount } = renderHook(() => useStickToBottom({ current: root }));
    setDims(viewport, 1000, 200);

    unmount();

    viewport.scrollTop = 0;
    grow(viewport);
    await flushObserver();

    expect(viewport.scrollTop).toBe(0);
  });

  it("is a no-op when the Root holds no Radix viewport", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(() => renderHook(() => useStickToBottom({ current: root }))).not.toThrow();

    // Nothing to follow: the bare root never gains a viewport, so a mutation on it can't move any scroll.
    root.appendChild(document.createElement("p"));
    await flushObserver();
    expect(root.scrollTop).toBe(0);
  });

  it("is a no-op when the Root ref is unset", () => {
    expect(() => renderHook(() => useStickToBottom({ current: null }))).not.toThrow();
  });
});
