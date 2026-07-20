import { describe, expect, it } from "vitest";

/**
 * #7576: a canary for the jsdom test environment's Web Storage, not for app code.
 *
 * Node 25 shipped a native `globalThis.localStorage` that evaluates to `undefined` unless
 * `--localstorage-file` is passed (nodejs/node#60303). Vitest's jsdom environment then skips copying
 * jsdom's real `Storage` over, because the key already appears to exist (vitest-dev/vitest#8757, closed
 * as "non-LTS is not supported"). `vitest.setup.ts` restores it from the raw JSDOM instance.
 *
 * `.nvmrc` pins Node 22 today, so this passes trivially on CI. Its job is to fail loudly the moment that
 * pin moves past Node 24 with the shim removed or broken, instead of every localStorage-touching suite
 * failing with an opaque `Cannot read properties of undefined (reading 'clear')`.
 */
describe("jsdom Web Storage availability (#7576)", () => {
  it.each(["localStorage", "sessionStorage"] as const)("exposes a working window.%s", (key) => {
    const storage = window[key];

    expect(storage).toBeDefined();
    expect(typeof storage.setItem).toBe("function");
    expect(typeof storage.getItem).toBe("function");
    expect(typeof storage.clear).toBe("function");

    storage.clear();
    storage.setItem("loopover.canary", "ok");
    expect(storage.getItem("loopover.canary")).toBe("ok");
    storage.clear();
    expect(storage.getItem("loopover.canary")).toBeNull();
  });

  it("resolves the bare global to the same Storage as the window property", () => {
    // The failure mode this guards is a global that exists but is undefined, so assert both handles
    // agree rather than only checking `window`.
    expect(globalThis.localStorage).toBe(window.localStorage);
    expect(globalThis.sessionStorage).toBe(window.sessionStorage);
  });
});
