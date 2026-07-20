import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount React trees between tests so jsdom state never leaks across cases.
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver -- recharts' ResponsiveContainer (used by any chart/sparkline) needs one to
// mount at all. A no-op stub is the standard fix: it never actually resizes in a test DOM, and no test here
// asserts on a resize-driven re-render, only on the rendered markup.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// #7576: Node 25+ ships a native globalThis.localStorage/sessionStorage that evaluates to `undefined`
// (nodejs/node#60303) when no --localstorage-file is set. Because `"localStorage" in globalThis` is then
// true, vitest's jsdom environment skips copying jsdom's own working Storage over (its getWindowKeys()
// only copies a key that is not already present on the global), leaving window.localStorage undefined and
// every localStorage-touching test throwing on the first `.clear()`/`.setItem()`. jsdom's real Storage is
// still reachable via the raw JSDOM instance vitest exposes as `globalThis.jsdom`, so restore it from there
// when the native global is broken. No-op on Node <=24 (the native global doesn't exist and jsdom's Storage
// was copied normally), so it never affects the .nvmrc-pinned Node 22 that CI runs on.
{
  const jsdomWindow = (globalThis as { jsdom?: { window?: Record<string, unknown> } }).jsdom?.window;
  for (const key of ["localStorage", "sessionStorage"] as const) {
    if ((globalThis as Record<string, unknown>)[key] == null && jsdomWindow?.[key] != null) {
      (globalThis as Record<string, unknown>)[key] = jsdomWindow[key];
    }
  }
}
