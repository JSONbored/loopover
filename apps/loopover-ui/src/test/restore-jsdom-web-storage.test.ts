import { afterEach, describe, expect, it } from "vitest";

import { restoreJsdomWebStorage } from "./restore-jsdom-web-storage";

// #7576: exercise the shim by SIMULATING Node 25+'s broken global (present-but-undefined localStorage) on a
// fake target, then asserting restoreJsdomWebStorage copies jsdom's working Storage back. This reproduces the
// real failure deterministically on any Node version, including CI's Node 22 where the native bug is absent.

/** A jsdom-like window carrying real Storage instances (the browser env vitest exposes as globalThis.jsdom.window). */
function fakeJsdomWindow() {
  const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window;
  return {
    localStorage: jsdomWindow?.localStorage ?? realStorage(),
    sessionStorage: jsdomWindow?.sessionStorage ?? realStorage(),
  } as unknown as Window;
}

/** Minimal in-memory Storage stand-in for environments where globalThis.jsdom isn't populated. */
function realStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

/** Build a fake global target reproducing Node 25+: `localStorage` present in the object but === undefined. */
function brokenNode25Target(jsdomWindow: Window) {
  const target = { jsdom: { window: jsdomWindow } } as unknown as typeof globalThis;
  Object.defineProperty(target, "localStorage", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(target, "sessionStorage", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  return target;
}

describe("restoreJsdomWebStorage (#7576)", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("copies jsdom's working Storage over Node 25+'s broken undefined global", () => {
    const jsdomWindow = fakeJsdomWindow();
    const target = brokenNode25Target(jsdomWindow);
    // Precondition: the key is PRESENT but undefined -- exactly the Node 25 shape vitest fails to overwrite.
    expect("localStorage" in target).toBe(true);
    expect(target.localStorage).toBeUndefined();

    restoreJsdomWebStorage(target);

    expect(target.localStorage).toBeTruthy();
    expect(target.sessionStorage).toBeTruthy();
    target.localStorage.setItem("k", "v");
    expect(target.localStorage.getItem("k")).toBe("v");
    // The window's own reference is restored too, so `window.localStorage` inside a test works.
    expect(jsdomWindow.localStorage.getItem("k")).toBe("v");
  });

  it("leaves an already-working Storage untouched (the Node 22 / CI no-op path)", () => {
    const jsdomWindow = fakeJsdomWindow();
    const working = realStorage();
    working.setItem("keep", "me");
    const target = {
      jsdom: { window: jsdomWindow },
      localStorage: working,
      sessionStorage: working,
    } as unknown as typeof globalThis;

    restoreJsdomWebStorage(target);

    // Same instance, not replaced by jsdom's -- the `if (target[key]) continue` guard fired.
    expect(target.localStorage).toBe(working);
    expect(target.localStorage.getItem("keep")).toBe("me");
  });

  it("no-ops when no jsdom instance is present (non-jsdom environment)", () => {
    const target = {} as typeof globalThis;
    expect(() => restoreJsdomWebStorage(target)).not.toThrow();
    expect("localStorage" in target).toBe(false);
  });

  it("skips a storage jsdom itself doesn't expose", () => {
    // jsdom window present but its sessionStorage is absent -> that key stays missing, localStorage still restored.
    const jsdomWindow = {
      localStorage: realStorage(),
      sessionStorage: undefined,
    } as unknown as Window;
    const target = brokenNode25Target(jsdomWindow);
    restoreJsdomWebStorage(target);
    expect(target.localStorage).toBeTruthy();
    expect(target.sessionStorage).toBeUndefined();
  });
});
