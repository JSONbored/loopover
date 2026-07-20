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

// #7576: restore jsdom's Web Storage on Node 25+. Node 25 shipped a native `globalThis.localStorage`
// that evaluates to `undefined` unless `--localstorage-file` is passed (nodejs/node#60303, still open).
// Vitest's jsdom environment copies a window key onto the test global only when that key is in its
// static allowlist OR not already present on `global`; `localStorage`/`sessionStorage` are in neither
// list, so on Node <=24 (where the key is absent) jsdom's real Storage is copied over, but on Node 25+
// the key IS present -- Node's own broken accessor -- and the copy is skipped, leaving `undefined`
// behind. Reported upstream as vitest-dev/vitest#8757 and closed as "non-LTS is not supported", so
// there is no fix to wait for. jsdom's working Storage is still reachable via the raw JSDOM instance
// vitest exposes as `globalThis.jsdom`, which needs no Node CLI flags (the suggested flag workarounds
// are unrecognized by the Node 22 that `.nvmrc` pins, so they would break CI). No-op on Node <=24.
const jsdomWindow = (globalThis as { jsdom?: { window?: Record<string, unknown> } }).jsdom?.window;
for (const storageKey of ["localStorage", "sessionStorage"] as const) {
  if (globalThis[storageKey] !== undefined || jsdomWindow?.[storageKey] === undefined) continue;
  Object.defineProperty(globalThis, storageKey, {
    value: jsdomWindow[storageKey],
    configurable: true,
    writable: true,
  });
}
