import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { restoreJsdomWebStorage } from "./src/test/restore-jsdom-web-storage";

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

// #7576: on Node 25+ vitest's jsdom environment leaves Node's broken native `localStorage` (undefined) in
// place instead of jsdom's working Storage; restore it before any test runs. No-op on Node 22 (`.nvmrc`).
restoreJsdomWebStorage();
