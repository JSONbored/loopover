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

// Node 26 predefines its own experimental `globalThis.localStorage` accessor (nodejs/node#60303) that
// returns undefined unless the process was started with --localstorage-file. Because that property already
// *exists* on globalThis before jsdom's env is installed, Vitest's populateGlobal skips copying jsdom's
// working Storage over it, so any bare `localStorage.*` call (use-local-storage.test.ts most directly,
// plus routes/index.test.tsx, api/try-it.test.ts, app-panels/onboarding-preview-card.test.tsx, and
// lib/analytics-window.test.ts) throws "Cannot read properties of undefined". jsdom's real Storage still
// lives on the raw JSDOM window (globalThis.jsdom.window, a distinct object from the `window`/globalThis
// alias); point the global at it
// unconditionally -- a no-op on Node 22/24 where globalThis.localStorage already *is* this object, and the
// actual fix on Node 26+. A `??=` guard would not help (the broken accessor already counts as "present");
// the property is configurable so redefining it is safe. Mirrors apps/loopover-miner-ui/vitest.setup.ts's
// own guard (#7597), which fixed the identical gap there but not here.
const jsdomLocalStorage = (globalThis as { jsdom?: { window?: { localStorage?: Storage } } }).jsdom
  ?.window?.localStorage;
if (jsdomLocalStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    value: jsdomLocalStorage,
    configurable: true,
    writable: true,
  });
}
