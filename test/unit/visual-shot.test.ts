import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureInteractionFrames, captureScrollFrames, captureShot, handleShot } from "../../src/review/visual/shot";
import { counterValue, resetMetrics } from "../../src/selfhost/metrics";

const mocks = vi.hoisted(() => ({
  finalUrl: "https://preview.pages.dev/page",
  screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
  abort: vi.fn(async () => undefined),
  continue: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  launch: vi.fn(),
  emulateMediaFeatures: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
  evaluate: vi.fn(),
  waitForSelector: vi.fn(),
  hover: vi.fn(async () => undefined),
  click: vi.fn(async () => undefined),
  boundingBox: vi.fn(async (): Promise<{ x: number; y: number; width: number; height: number } | null> => ({ x: 0, y: 0, width: 100, height: 40 })),
  scrollIntoViewIfNeeded: vi.fn(async () => undefined),
  mouseMove: vi.fn(async () => undefined),
  mouseDown: vi.fn(async () => undefined),
  mouseUp: vi.fn(async () => undefined),
  // captureScrollFrames' FIRST page.evaluate() call queries scrollHeight; every later call (scrollTo, the
  // settle delay) discards its return value — so only the first call's resolved value matters to the code
  // under test, regardless of exactly how many scroll/settle evaluate() calls happen after it. captureShot's
  // own bounded-full-page-screenshot height check is likewise a single evaluate() call, so it reuses this
  // same mock rather than introducing a second, redundant height property.
  scrollHeight: 900,
  evaluateCallCount: 0,
  // #9044 DNS-resolution pin: a public, non-private address by default so every existing test's target host
  // resolves "safely" and none of them exercise the new guard unintentionally — matching every other default
  // in this hoisted object being the "everything is fine" case. Individual tests override via
  // mockResolvedValueOnce/mockRejectedValueOnce/mockReturnValueOnce, consumed once and reverting to this
  // default afterward (vi.clearAllMocks() in each beforeEach clears call history only, never this base
  // implementation — same convention every other mock in this file already relies on).
  dnsLookup: vi.fn(async (_hostname: string) => ({ address: "93.184.216.34", family: 4 as const })),
}));

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    launch: mocks.launch,
  },
}));

vi.mock("node:dns/promises", () => ({
  lookup: (hostname: string) => mocks.dnsLookup(hostname),
}));

function env(): Env {
  return { BROWSER: {} } as Env;
}

function request(url: string): Request {
  return new Request(`https://api.example.test/loopover/shot?url=${encodeURIComponent(url)}`);
}

function shotRequest(query: string): Request {
  return new Request(`https://api.example.test/loopover/shot?${query}`);
}

// Minimal R2 stub: REVIEW_AUDIT.get(key) returns an object whose `.body` is a byte stream, or null.
function r2Env(objects: Record<string, Uint8Array>): Env {
  return {
    REVIEW_AUDIT: {
      get: async (key: string) =>
        objects[key] ? { body: new Response(objects[key]).body } : null,
    },
  } as unknown as Env;
}

// A minimal (not fully spec-complete) PNG buffer whose IHDR chunk reports the given width/height -- enough
// for readPngDimensions() to parse, which is all captureBoundedFullPageShot's post-capture check reads.
function fakePng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.set([0x00, 0x00, 0x00, 0x0d], 8);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(buf.buffer).setUint32(16, width, false);
  new DataView(buf.buffer).setUint32(20, height, false);
  return buf;
}

function makeRequest(url: string, navigation = true) {
  return {
    url: () => url,
    isNavigationRequest: () => navigation,
    abort: mocks.abort,
    continue: mocks.continue,
  };
}

describe("visual screenshot on-demand SSRF guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 900;
    mocks.evaluateCallCount = 0;
    mocks.screenshot.mockResolvedValue(fakePng(1440, 900));
    mocks.evaluate.mockImplementation(async (fn: (...fnArgs: unknown[]) => unknown, ...fnArgs: unknown[]) => {
      mocks.evaluateCallCount++;
      // The real callback runs inside the browser's own realm (document/window), which this Node test
      // environment doesn't have — invoking it anyway and swallowing the inevitable throw is enough to
      // exercise its body (real coverage, not just "the mock was configured") without needing a real DOM.
      try {
        fn(...fnArgs);
      } catch {
        // expected — see above.
      }
      // The height/scrollHeight probe is the only zero-arg evaluate() call in either function — everything
      // else (scrollTo, the #4109 localStorage-forcing callback) always passes at least one extra arg. Keying
      // off arg count (not call order) keeps this resolvable regardless of whether a themeStorageKey-forcing
      // evaluate() call runs BEFORE the height probe, which it now can (#4109).
      return fnArgs.length === 0 ? mocks.scrollHeight : undefined;
    });
    mocks.launch.mockImplementation(async () => {
      let onRequest: ((request: ReturnType<typeof makeRequest>) => void) | undefined;
      return {
        newPage: async () => ({
          setRequestInterception: vi.fn(async () => undefined),
          on: vi.fn((event: string, callback: (request: ReturnType<typeof makeRequest>) => void) => {
            if (event === "request") onRequest = callback;
          }),
          setViewport: vi.fn(async () => undefined),
          emulateMediaFeatures: mocks.emulateMediaFeatures,
          goto: vi.fn(async (url: string) => {
            onRequest?.(makeRequest(url));
            if (mocks.finalUrl !== url) onRequest?.(makeRequest(mocks.finalUrl));
          }),
          reload: mocks.reload,
          url: vi.fn(() => mocks.finalUrl),
          screenshot: mocks.screenshot,
          evaluate: mocks.evaluate,
        }),
        close: mocks.close,
      };
    });
  });

  it("rejects direct unsafe screenshot targets before launching the browser", async () => {
    const response = await handleShot(request("http://127.0.0.1/admin"), env());

    expect(response.status).toBe(400);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("does not screenshot a redirect from an allowlisted host to a private endpoint", async () => {
    mocks.finalUrl = "http://127.0.0.1/admin";

    const response = await handleShot(request("https://attacker.workers.dev/redirect"), env());

    expect(response.status).toBe(502);
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.screenshot).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it("does not screenshot a redirect from an allowlisted host to an unallowlisted public host", async () => {
    mocks.finalUrl = "https://example.com/public";

    const response = await handleShot(request("https://attacker.workers.dev/redirect"), env());

    expect(response.status).toBe(502);
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.screenshot).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it("renders when the final navigation remains safe and allowlisted", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";

    const response = await handleShot(request("https://preview.pages.dev/page"), env());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(mocks.continue).toHaveBeenCalled();
    expect(mocks.screenshot).toHaveBeenCalled();
  });

  it("captures the full page for bounded review pages", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 10_000;

    await handleShot(request("https://preview.pages.dev/page"), env());

    expect(mocks.screenshot).toHaveBeenCalledWith({ type: "png", fullPage: true });
  });

  it("rejects attacker-controlled pages taller than the full-page screenshot cap before rasterizing", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 10_001;

    const response = await handleShot(request("https://preview.pages.dev/page"), env());

    expect(response.status).toBe(502);
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("rejects full-page screenshots whose pixel area exceeds the cap", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 10_000;

    const response = await handleShot(shotRequest(`url=${encodeURIComponent("https://preview.pages.dev/page")}&w=2560&h=900`), env());

    expect(response.status).toBe(502);
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("rejects oversized PNG output before returning it from the public shot route", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.screenshot.mockResolvedValue(new Uint8Array(5 * 1024 * 1024 + 1));

    const response = await handleShot(request("https://preview.pages.dev/page"), env());

    expect(response.status).toBe(502);
  });

  it("REGRESSION (security review, #3712): rejects an oversized screenshot even when the page's own evaluate() height lies", async () => {
    // A hostile page can override document.body/documentElement scrollHeight/offsetHeight getters to
    // under-report its own height and sail through the pre-capture fast-path check.
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 100;
    mocks.screenshot.mockResolvedValue(fakePng(1440, 10_001));

    const response = await handleShot(request("https://preview.pages.dev/page"), env());

    expect(response.status).toBe(502);
  });

  it("REGRESSION (security review, #3712): rejects a spoofed page whose real PNG area (not height alone) exceeds the cap", async () => {
    // Height (6000) is under MAX_SCREENSHOT_HEIGHT on its own -- only the width*height area check should
    // catch this one, isolating that OR-branch from the height branch exercised by the test above.
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 100;
    mocks.screenshot.mockResolvedValue(fakePng(2560, 6000));

    const response = await handleShot(shotRequest(`url=${encodeURIComponent("https://preview.pages.dev/page")}&w=2560&h=100`), env());

    expect(response.status).toBe(502);
  });

  it("REGRESSION (security review, #3712): fails closed when the rasterized output is not a well-formed PNG", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.screenshot.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const response = await handleShot(request("https://preview.pages.dev/page"), env());

    expect(response.status).toBe(502);
  });

  it("times out screenshot rasterization that does not finish", async () => {
    vi.useFakeTimers();
    try {
      mocks.finalUrl = "https://preview.pages.dev/page";
      mocks.screenshot.mockReturnValue(new Promise(() => undefined));

      const result = captureShot(env(), "https://preview.pages.dev/page");
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toEqual({ png: null, authWalled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESSION (security review): times out a hostile page-realm height probe before rasterization", async () => {
    vi.useFakeTimers();
    try {
      mocks.finalUrl = "https://preview.pages.dev/page";
      mocks.evaluate.mockReturnValue(new Promise(() => undefined));

      const result = captureShot(env(), "https://preview.pages.dev/page");
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(result).resolves.toEqual({ png: null, authWalled: false });
      expect(mocks.screenshot).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never emulates a color scheme when no theme is requested — every existing caller, byte-identical to today", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    await captureShot(env(), "https://preview.pages.dev/page");
    expect(mocks.emulateMediaFeatures).not.toHaveBeenCalled();
  });

  it("emulates prefers-color-scheme when a theme is requested (#3678)", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    await captureShot(env(), "https://preview.pages.dev/page", undefined, { theme: "dark" });
    expect(mocks.emulateMediaFeatures).toHaveBeenCalledWith([{ name: "prefers-color-scheme", value: "dark" }]);
  });

  it("handleShot's on-demand render reads &theme= and emulates it (#3678)", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    const response = await handleShot(shotRequest(`url=${encodeURIComponent("https://preview.pages.dev/page")}&theme=dark`), env());
    expect(response.status).toBe(200);
    expect(mocks.emulateMediaFeatures).toHaveBeenCalledWith([{ name: "prefers-color-scheme", value: "dark" }]);
  });

  it("handleShot ignores an unrecognized &theme= value instead of rejecting the request", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    const response = await handleShot(shotRequest(`url=${encodeURIComponent("https://preview.pages.dev/page")}&theme=sepia`), env());
    expect(response.status).toBe(200);
    expect(mocks.emulateMediaFeatures).not.toHaveBeenCalled();
  });

  it("handleShot never emulates a color scheme when &theme= is absent — byte-identical to pre-#3678", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    const response = await handleShot(request("https://preview.pages.dev/page"), env());
    expect(response.status).toBe(200);
    expect(mocks.emulateMediaFeatures).not.toHaveBeenCalled();
  });

  it("forces the theme via localStorage.setItem + reload when both theme and themeStorageKey are set (#4109)", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    await captureShot(env(), "https://preview.pages.dev/page", undefined, { theme: "dark", themeStorageKey: "theme" });
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.any(Function), "theme", "dark");
    expect(mocks.reload).toHaveBeenCalledWith({ waitUntil: "networkidle0", timeout: 20000 });
  });

  it("REGRESSION (security review): times out a hostile theme localStorage write before reload", async () => {
    vi.useFakeTimers();
    try {
      mocks.finalUrl = "https://preview.pages.dev/page";
      mocks.evaluate.mockImplementation((fn: (...fnArgs: unknown[]) => unknown, ...fnArgs: unknown[]) => {
        if (fnArgs.length > 0) return new Promise(() => undefined);
        try {
          fn(...fnArgs);
        } catch {
          // expected — see default mock comment above.
        }
        return Promise.resolve(mocks.scrollHeight);
      });

      const result = captureShot(env(), "https://preview.pages.dev/page", undefined, { theme: "dark", themeStorageKey: "theme" });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(result).resolves.toEqual({ png: null, authWalled: false });
      expect(mocks.reload).not.toHaveBeenCalled();
      expect(mocks.screenshot).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never forces a theme via localStorage/reload when no themeStorageKey is configured — byte-identical to pre-#4109", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    await captureShot(env(), "https://preview.pages.dev/page", undefined, { theme: "dark" });
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("never forces a theme via localStorage/reload when themeStorageKey is set but theme is not (#4109)", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    await captureShot(env(), "https://preview.pages.dev/page", undefined, { themeStorageKey: "theme" });
    expect(mocks.emulateMediaFeatures).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("handleShot's on-demand render reads &themeStorageKey= only alongside a recognized &theme= (#4109)", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    const response = await handleShot(shotRequest(`url=${encodeURIComponent("https://preview.pages.dev/page")}&theme=dark&themeStorageKey=theme`), env());
    expect(response.status).toBe(200);
    expect(mocks.reload).toHaveBeenCalledWith({ waitUntil: "networkidle0", timeout: 20000 });
  });

  it("handleShot ignores &themeStorageKey= when &theme= is absent (#4109)", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";
    const response = await handleShot(shotRequest(`url=${encodeURIComponent("https://preview.pages.dev/page")}&themeStorageKey=theme`), env());
    expect(response.status).toBe(200);
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("captureShot rejects an unsafe target before launching the browser (defense-in-depth)", async () => {
    const result = await captureShot(env(), "http://127.0.0.1/admin");
    expect(result).toEqual({ png: null, authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("aborts a sub-request whose URL fails to parse", async () => {
    mocks.finalUrl = "::::not-a-url";
    const response = await handleShot(request("https://preview.pages.dev/page"), env());
    expect(response.status).toBe(502);
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("does not apply the http SSRF check to a non-http(s) sub-request protocol", async () => {
    mocks.finalUrl = "ftp://files.example.com/x";
    const response = await handleShot(request("https://preview.pages.dev/page"), env());
    expect(response.status).toBe(502); // final url is non-http(s) -> redirect-blocked downstream
    expect(mocks.continue).toHaveBeenCalled();
  });

  it("swallows continue() and abort() rejections on the allowed + unparseable sub-requests", async () => {
    // first request (allowed) continues; the rejected continue() must be swallowed by its .catch
    mocks.continue.mockRejectedValueOnce(new Error("continue failed"));
    // second request (unparseable URL) aborts; the rejected abort() must be swallowed by its .catch
    mocks.abort.mockRejectedValueOnce(new Error("abort failed"));
    mocks.finalUrl = "::::not-a-url";
    const response = await handleShot(request("https://preview.pages.dev/page"), env());
    expect(response.status).toBe(502);
  });

  it("swallows an abort() rejection on an unsafe-host sub-request", async () => {
    mocks.abort.mockRejectedValueOnce(new Error("abort failed"));
    mocks.finalUrl = "http://127.0.0.1/admin";
    const response = await handleShot(request("https://preview.pages.dev/page"), env());
    expect(response.status).toBe(502);
  });
});

describe("captureScrollFrames (#3612 scroll-through GIF evidence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 900;
    mocks.evaluateCallCount = 0;
    mocks.evaluate.mockImplementation(async (fn: (...fnArgs: unknown[]) => unknown, ...fnArgs: unknown[]) => {
      mocks.evaluateCallCount++;
      // The real callback runs inside the browser's own realm (document/window), which this Node test
      // environment doesn't have — invoking it anyway and swallowing the inevitable throw is enough to
      // exercise its body (real coverage, not just "the mock was configured") without needing a real DOM.
      try {
        fn(...fnArgs);
      } catch {
        // expected — see above.
      }
      // The height/scrollHeight probe is the only zero-arg evaluate() call in either function — everything
      // else (scrollTo, the #4109 localStorage-forcing callback) always passes at least one extra arg. Keying
      // off arg count (not call order) keeps this resolvable regardless of whether a themeStorageKey-forcing
      // evaluate() call runs BEFORE the height probe, which it now can (#4109).
      return fnArgs.length === 0 ? mocks.scrollHeight : undefined;
    });
    mocks.launch.mockImplementation(async () => {
      let onRequest: ((request: ReturnType<typeof makeRequest>) => void) | undefined;
      return {
        newPage: async () => ({
          setRequestInterception: vi.fn(async () => undefined),
          on: vi.fn((event: string, callback: (request: ReturnType<typeof makeRequest>) => void) => {
            if (event === "request") onRequest = callback;
          }),
          setViewport: vi.fn(async () => undefined),
          emulateMediaFeatures: mocks.emulateMediaFeatures,
          goto: vi.fn(async (url: string) => {
            onRequest?.(makeRequest(url));
            if (mocks.finalUrl !== url) onRequest?.(makeRequest(mocks.finalUrl));
          }),
          reload: mocks.reload,
          url: vi.fn(() => mocks.finalUrl),
          screenshot: mocks.screenshot,
          evaluate: mocks.evaluate,
        }),
        close: mocks.close,
      };
    });
  });

  it("rejects an unsafe target before launching the browser", async () => {
    const result = await captureScrollFrames(env(), "http://127.0.0.1/admin", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("captures MAX_SCROLL_STEPS viewport-cropped frames for a page much taller than one viewport", async () => {
    mocks.scrollHeight = 900 * 10; // a 10-viewport-tall page
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result.authWalled).toBe(false);
    expect(result.frames).toHaveLength(6);
    expect(mocks.screenshot).toHaveBeenCalledTimes(6);
    expect(mocks.screenshot).toHaveBeenCalledWith({ type: "png", fullPage: false });
  });

  it("captures exactly one frame for a page that fits within a single viewport (nothing to scroll through)", async () => {
    mocks.scrollHeight = 500; // shorter than the 900px viewport
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result.frames).toHaveLength(1);
    expect(mocks.screenshot).toHaveBeenCalledTimes(1);
  });

  it("emulates prefers-color-scheme when a theme is requested, same as captureShot", async () => {
    await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 }, { theme: "dark" });
    expect(mocks.emulateMediaFeatures).toHaveBeenCalledWith([{ name: "prefers-color-scheme", value: "dark" }]);
  });

  it("forces the theme via localStorage.setItem + reload when both theme and themeStorageKey are set, mirroring captureShot (#4109)", async () => {
    await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 }, { theme: "dark", themeStorageKey: "theme" });
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.any(Function), "theme", "dark");
    expect(mocks.reload).toHaveBeenCalledWith({ waitUntil: "networkidle0", timeout: 20000 });
  });

  it("REGRESSION (security review): times out a hostile theme localStorage write before scroll capture", async () => {
    vi.useFakeTimers();
    try {
      mocks.evaluate.mockImplementation((fn: (...fnArgs: unknown[]) => unknown, ...fnArgs: unknown[]) => {
        if (fnArgs.length > 0) return new Promise(() => undefined);
        try {
          fn(...fnArgs);
        } catch {
          // expected — see default mock comment above.
        }
        return Promise.resolve(mocks.scrollHeight);
      });

      const result = captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 }, { theme: "dark", themeStorageKey: "theme" });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(result).resolves.toEqual({ frames: [], authWalled: false });
      expect(mocks.reload).not.toHaveBeenCalled();
      expect(mocks.screenshot).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never forces a theme via localStorage/reload when no themeStorageKey is configured — byte-identical to pre-#4109", async () => {
    await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 }, { theme: "dark" });
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("returns no frames when a redirect leads to a private endpoint", async () => {
    mocks.finalUrl = "http://127.0.0.1/admin";
    const result = await captureScrollFrames(env(), "https://attacker.workers.dev/redirect", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.screenshot).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it("flags authWalled and captures no frames on a login-page redirect", async () => {
    mocks.finalUrl = "https://preview.pages.dev/login";
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/dashboard", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: true });
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("returns no frames when there is no BROWSER binding", async () => {
    const result = await captureScrollFrames({} as Env, "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("degrades to no frames when the browser throws mid-capture", async () => {
    mocks.launch.mockRejectedValueOnce(new Error("binding exhausted"));
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
  });

  it("aborts a sub-request whose URL fails to parse", async () => {
    mocks.finalUrl = "::::not-a-url";
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("swallows continue() and abort() rejections on the allowed + unparseable sub-requests", async () => {
    mocks.continue.mockRejectedValueOnce(new Error("continue failed"));
    mocks.abort.mockRejectedValueOnce(new Error("abort failed"));
    mocks.finalUrl = "::::not-a-url";
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
  });

  it("swallows an abort() rejection on an unsafe-host sub-request", async () => {
    mocks.abort.mockRejectedValueOnce(new Error("abort failed"));
    mocks.finalUrl = "http://127.0.0.1/admin";
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
  });

  it("swallows a close() rejection in the finally block", async () => {
    mocks.close.mockRejectedValueOnce(new Error("close failed"));
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result.authWalled).toBe(false);
    expect(mocks.close).toHaveBeenCalled();
  });

  it("does not apply the http SSRF check to a non-http(s) sub-request protocol", async () => {
    mocks.finalUrl = "ftp://files.example.com/x";
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false }); // final url is non-http(s) -> redirect-blocked downstream
    expect(mocks.continue).toHaveBeenCalled();
  });

  it("honors a caller-supplied isAllowedUrl on both the initial target and each sub-request", async () => {
    const isAllowedUrl = vi.fn((candidate: string) => candidate === "https://preview.pages.dev/page");
    mocks.finalUrl = "https://preview.pages.dev/page";
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 }, { isAllowedUrl });
    expect(result.authWalled).toBe(false);
    expect(result.frames.length).toBeGreaterThan(0);
    expect(mocks.continue).toHaveBeenCalled();
    expect(isAllowedUrl).toHaveBeenCalledWith("https://preview.pages.dev/page");
  });

  it("rejects the target up front when isAllowedUrl disallows it, before launching the browser", async () => {
    const isAllowedUrl = vi.fn(() => false);
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 }, { isAllowedUrl });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("aborts a sub-request whose navigation isAllowedUrl disallows, even though the host itself is otherwise safe", async () => {
    const isAllowedUrl = vi.fn((candidate: string) => candidate === "https://preview.pages.dev/page");
    mocks.finalUrl = "https://preview.pages.dev/other-page"; // safe host, but not the one isAllowedUrl accepts
    const result = await captureScrollFrames(env(), "https://preview.pages.dev/page", { width: 1440, height: 900 }, { isAllowedUrl });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });
});

describe("captureInteractionFrames (#interaction-gif-capture)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.evaluateCallCount = 0;
    mocks.waitForSelector.mockResolvedValue({ hover: mocks.hover, click: mocks.click, boundingBox: mocks.boundingBox, scrollIntoViewIfNeeded: mocks.scrollIntoViewIfNeeded });
    mocks.boundingBox.mockResolvedValue({ x: 0, y: 0, width: 100, height: 40 });
    mocks.evaluate.mockImplementation(async (fn: (...fnArgs: unknown[]) => unknown, ...fnArgs: unknown[]) => {
      mocks.evaluateCallCount++;
      try {
        fn(...fnArgs);
      } catch {
        // expected — see the shared mock comment above.
      }
      return undefined;
    });
    mocks.launch.mockImplementation(async () => {
      let onRequest: ((request: ReturnType<typeof makeRequest>) => void) | undefined;
      return {
        newPage: async () => ({
          setRequestInterception: vi.fn(async () => undefined),
          on: vi.fn((event: string, callback: (request: ReturnType<typeof makeRequest>) => void) => {
            if (event === "request") onRequest = callback;
          }),
          setViewport: vi.fn(async () => undefined),
          emulateMediaFeatures: mocks.emulateMediaFeatures,
          goto: vi.fn(async (url: string) => {
            onRequest?.(makeRequest(url));
            if (mocks.finalUrl !== url) onRequest?.(makeRequest(mocks.finalUrl));
          }),
          reload: mocks.reload,
          url: vi.fn(() => mocks.finalUrl),
          screenshot: mocks.screenshot,
          evaluate: mocks.evaluate,
          waitForSelector: mocks.waitForSelector,
          mouse: { move: mocks.mouseMove, down: mocks.mouseDown, up: mocks.mouseUp },
        }),
        close: mocks.close,
      };
    });
  });

  it("rejects an unsafe target before launching the browser", async () => {
    const result = await captureInteractionFrames(env(), "http://127.0.0.1/admin", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("captures an at-rest frame plus MAX_INTERACTION_STEPS-1 post-interaction frames for a hover", async () => {
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".blocks-row", "hover", { width: 1440, height: 900 });
    expect(result.authWalled).toBe(false);
    expect(result.frames).toHaveLength(4);
    expect(mocks.screenshot).toHaveBeenCalledTimes(4);
    expect(mocks.screenshot).toHaveBeenCalledWith({ type: "png", fullPage: false });
    expect(mocks.hover).toHaveBeenCalledTimes(1);
    expect(mocks.click).not.toHaveBeenCalled();
  });

  it("clicks (not hovers) the element when action is 'click'", async () => {
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", "#menu-button", "click", { width: 1440, height: 900 });
    expect(result.frames).toHaveLength(4);
    expect(mocks.click).toHaveBeenCalledTimes(1);
    expect(mocks.hover).not.toHaveBeenCalled();
  });

  it("returns no frames (fails open) when the selector matches nothing on the page", async () => {
    mocks.waitForSelector.mockResolvedValue(null);
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".does-not-exist", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("returns no frames when there is no BROWSER binding", async () => {
    const result = await captureInteractionFrames({} as Env, "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("emulates prefers-color-scheme when a theme is requested, same as captureScrollFrames/captureShot", async () => {
    await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 }, { theme: "dark" });
    expect(mocks.emulateMediaFeatures).toHaveBeenCalledWith([{ name: "prefers-color-scheme", value: "dark" }]);
  });

  it("forces the theme via localStorage.setItem + reload when both theme and themeStorageKey are set, mirroring captureScrollFrames (#4109)", async () => {
    await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 }, { theme: "dark", themeStorageKey: "theme" });
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.any(Function), "theme", "dark");
    expect(mocks.reload).toHaveBeenCalledWith({ waitUntil: "networkidle0", timeout: 20000 });
  });

  it("REGRESSION (security review): times out a hostile theme localStorage write before reload, mirroring captureShot/captureScrollFrames", async () => {
    vi.useFakeTimers();
    try {
      mocks.evaluate.mockImplementation((fn: (...fnArgs: unknown[]) => unknown, ...fnArgs: unknown[]) => {
        if (fnArgs.length > 0) return new Promise(() => undefined);
        try {
          fn(...fnArgs);
        } catch {
          // expected — see default mock comment above.
        }
        return Promise.resolve(undefined);
      });

      const result = captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 }, { theme: "dark", themeStorageKey: "theme" });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(result).resolves.toEqual({ frames: [], authWalled: false });
      expect(mocks.reload).not.toHaveBeenCalled();
      expect(mocks.screenshot).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags authWalled and captures no frames on a login-page redirect", async () => {
    mocks.finalUrl = "https://preview.pages.dev/login";
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/dashboard", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: true });
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("degrades to no frames (never throws) when the browser throws mid-capture", async () => {
    mocks.launch.mockRejectedValue(new Error("binding exhausted"));
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
  });

  it("rejects the target up front when isAllowedUrl disallows it, before launching the browser", async () => {
    const isAllowedUrl = vi.fn(() => false);
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 }, { isAllowedUrl });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("closes the browser even when waitForSelector throws", async () => {
    mocks.waitForSelector.mockRejectedValue(new Error("timed out"));
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.close).toHaveBeenCalled();
  });

  it("returns no frames when a redirect leads to a private endpoint", async () => {
    mocks.finalUrl = "http://127.0.0.1/admin";
    const result = await captureInteractionFrames(env(), "https://attacker.workers.dev/redirect", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.screenshot).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it("aborts a sub-request whose URL fails to parse", async () => {
    mocks.finalUrl = "::::not-a-url";
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("swallows continue() and abort() rejections on the allowed + unparseable sub-requests", async () => {
    mocks.continue.mockRejectedValueOnce(new Error("continue failed"));
    mocks.abort.mockRejectedValueOnce(new Error("abort failed"));
    mocks.finalUrl = "::::not-a-url";
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
  });

  it("swallows an abort() rejection on an unsafe-host sub-request", async () => {
    mocks.abort.mockRejectedValueOnce(new Error("abort failed"));
    mocks.finalUrl = "http://127.0.0.1/admin";
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
  });

  it("does not apply the http SSRF check to a non-http(s) sub-request protocol", async () => {
    mocks.finalUrl = "ftp://files.example.com/x";
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false }); // final url is non-http(s) -> redirect-blocked downstream
    expect(mocks.continue).toHaveBeenCalled();
  });

  it("aborts a sub-request whose navigation isAllowedUrl disallows, even though the host itself is otherwise safe", async () => {
    const isAllowedUrl = vi.fn((candidate: string) => candidate === "https://preview.pages.dev/page");
    mocks.finalUrl = "https://preview.pages.dev/other-page";
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 }, { isAllowedUrl });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.abort).toHaveBeenCalled();
    expect(mocks.screenshot).not.toHaveBeenCalled();
  });

  it("swallows a close() rejection in the finally block", async () => {
    mocks.close.mockRejectedValueOnce(new Error("close failed"));
    const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result.authWalled).toBe(false);
    expect(mocks.close).toHaveBeenCalled();
  });

  describe("drag action (#interaction-gif-capture drag support)", () => {
    it("drags the source onto the destination via mouse down/interpolated-move/up, using each element's bounding-box center", async () => {
      mocks.boundingBox.mockResolvedValueOnce({ x: 0, y: 0, width: 100, height: 40 }).mockResolvedValueOnce({ x: 400, y: 200, width: 60, height: 60 });
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(result.authWalled).toBe(false);
      expect(result.frames).toHaveLength(4);
      expect(mocks.waitForSelector).toHaveBeenCalledWith(".card", { timeout: 3_000 });
      expect(mocks.waitForSelector).toHaveBeenCalledWith(".done-column", { timeout: 3_000 });
      // source center (50, 20) -> destination center (430, 230): down at the source, up at the destination,
      // with 8 interpolated positions in between (DRAG_MOVE_STEPS).
      expect(mocks.mouseMove).toHaveBeenCalledWith(50, 20);
      expect(mocks.mouseDown).toHaveBeenCalledTimes(1);
      expect(mocks.mouseMove).toHaveBeenLastCalledWith(430, 230);
      expect(mocks.mouseUp).toHaveBeenCalledTimes(1);
      // 1 initial move to the source + 8 interpolation steps = 9 total move() calls.
      expect(mocks.mouseMove).toHaveBeenCalledTimes(9);
    });

    it("returns no frames (fails open) when drag_to is not provided for a drag action", async () => {
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 });
      expect(result).toEqual({ frames: [], authWalled: false });
      expect(mocks.mouseDown).not.toHaveBeenCalled();
    });

    it("returns no frames (fails open) when the drag destination selector matches nothing on the page", async () => {
      mocks.waitForSelector.mockImplementation(async (selector: string) =>
        selector === ".done-column" ? null : { hover: mocks.hover, click: mocks.click, boundingBox: mocks.boundingBox },
      );
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(result).toEqual({ frames: [], authWalled: false });
      expect(mocks.mouseDown).not.toHaveBeenCalled();
    });

    it("returns no frames (fails open, never throws) when waiting for the drag destination selector itself rejects", async () => {
      mocks.waitForSelector.mockImplementation(async (selector: string) => {
        if (selector === ".done-column") throw new Error("timed out");
        return { hover: mocks.hover, click: mocks.click, boundingBox: mocks.boundingBox };
      });
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(result).toEqual({ frames: [], authWalled: false });
      expect(mocks.mouseDown).not.toHaveBeenCalled();
    });

    it("no-ops the drag (never throws) when either element has no bounding box (display:none / zero-size)", async () => {
      mocks.boundingBox.mockResolvedValue(null);
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      // Frame capture still proceeds (the drag itself is a no-op, not a capture failure) — one at-rest frame
      // plus the post-interaction settle frames, same shape as a successful hover/click.
      expect(result.frames).toHaveLength(4);
      expect(mocks.mouseDown).not.toHaveBeenCalled();
      expect(mocks.mouseUp).not.toHaveBeenCalled();
    });

    it("no-ops the drag when only the SOURCE has no bounding box (destination alone is not enough)", async () => {
      mocks.boundingBox.mockResolvedValueOnce(null).mockResolvedValueOnce({ x: 400, y: 200, width: 60, height: 60 });
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(result.frames).toHaveLength(4);
      expect(mocks.mouseDown).not.toHaveBeenCalled();
    });

    it("no-ops the drag when only the DESTINATION has no bounding box (source alone is not enough)", async () => {
      mocks.boundingBox.mockResolvedValueOnce({ x: 0, y: 0, width: 100, height: 40 }).mockResolvedValueOnce(null);
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(result.frames).toHaveLength(4);
      expect(mocks.mouseDown).not.toHaveBeenCalled();
    });

    it("scrolls both the source and destination into view before reading their bounding boxes", async () => {
      await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(mocks.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(2);
    });

    it("still performs the drag (never throws) when scrollIntoViewIfNeeded itself rejects, for BOTH the source and the destination", async () => {
      // mockRejectedValue (not -Once) rejects every call — both the source's scrollIntoViewIfNeeded (before
      // reading its bounding box) and the destination's (a separate call, same shared element mock) reject,
      // exercising both catch sites independently rather than just the first one reached.
      mocks.scrollIntoViewIfNeeded.mockRejectedValue(new Error("scroll failed"));
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(result.frames).toHaveLength(4);
      expect(mocks.mouseDown).toHaveBeenCalledTimes(1);
      expect(mocks.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(2);
    });

    it("still performs the drag when an element has no scrollIntoViewIfNeeded method at all (optional per the ElementHandle-subset type)", async () => {
      mocks.waitForSelector.mockImplementation(async (selector: string) =>
        selector === ".done-column"
          ? { hover: mocks.hover, click: mocks.click, boundingBox: mocks.boundingBox }
          : { hover: mocks.hover, click: mocks.click, boundingBox: mocks.boundingBox, scrollIntoViewIfNeeded: mocks.scrollIntoViewIfNeeded },
      );
      const result = await captureInteractionFrames(env(), "https://preview.pages.dev/page", ".card", "drag", { width: 1440, height: 900 }, {}, ".done-column");
      expect(result.frames).toHaveLength(4);
      // Source still scrolls (it has the method); destination has none, so optional chaining short-circuits
      // to undefined rather than throwing — the drag itself still completes using its bounding box as-is.
      expect(mocks.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
      expect(mocks.mouseDown).toHaveBeenCalledTimes(1);
      expect(mocks.mouseUp).toHaveBeenCalledTimes(1);
    });
  });
});

describe("DNS-resolution pin (#9044, best-effort SSRF defense-in-depth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalUrl = "https://preview.pages.dev/page";
    mocks.scrollHeight = 900;
    mocks.dnsLookup.mockResolvedValue({ address: "93.184.216.34", family: 4 });
    mocks.evaluate.mockImplementation(async (fn: (...fnArgs: unknown[]) => unknown, ...fnArgs: unknown[]) => {
      try {
        fn(...fnArgs);
      } catch {
        // expected — see the shared mock comment at the top of this file.
      }
      return fnArgs.length === 0 ? mocks.scrollHeight : undefined;
    });
    mocks.launch.mockImplementation(async () => {
      let onRequest: ((request: ReturnType<typeof makeRequest>) => void) | undefined;
      return {
        newPage: async () => ({
          setRequestInterception: vi.fn(async () => undefined),
          on: vi.fn((event: string, callback: (request: ReturnType<typeof makeRequest>) => void) => {
            if (event === "request") onRequest = callback;
          }),
          setViewport: vi.fn(async () => undefined),
          emulateMediaFeatures: mocks.emulateMediaFeatures,
          goto: vi.fn(async (url: string) => {
            onRequest?.(makeRequest(url));
            if (mocks.finalUrl !== url) onRequest?.(makeRequest(mocks.finalUrl));
          }),
          reload: mocks.reload,
          url: vi.fn(() => mocks.finalUrl),
          screenshot: mocks.screenshot,
          evaluate: mocks.evaluate,
          waitForSelector: mocks.waitForSelector,
          mouse: { move: mocks.mouseMove, down: mocks.mouseDown, up: mocks.mouseUp },
        }),
        close: mocks.close,
      };
    });
  });

  it("captureShot rejects a public hostname whose DNS resolves to a disallowed address, before launching the browser", async () => {
    mocks.dnsLookup.mockResolvedValueOnce({ address: "169.254.169.254", family: 4 }); // cloud metadata
    const result = await captureShot(env(), "https://attacker-controlled.pages.dev/page");
    expect(result).toEqual({ png: null, authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("captureScrollFrames rejects a public hostname whose DNS resolves to a disallowed address", async () => {
    mocks.dnsLookup.mockResolvedValueOnce({ address: "127.0.0.1", family: 4 });
    const result = await captureScrollFrames(env(), "https://attacker-controlled.pages.dev/page", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("captureInteractionFrames rejects a public hostname whose DNS resolves to a disallowed address", async () => {
    mocks.dnsLookup.mockResolvedValueOnce({ address: "10.0.0.5", family: 4 });
    const result = await captureInteractionFrames(env(), "https://attacker-controlled.pages.dev/page", ".x", "hover", { width: 1440, height: 900 });
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("fails open (still renders) when DNS resolution errors -- not the sole guard, defense-in-depth only", async () => {
    mocks.dnsLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const response = await handleShot(request("https://preview.pages.dev/page"), env());
    expect(response.status).toBe(200);
  });

  it("fails open (still renders) when the DNS lookup times out", async () => {
    vi.useFakeTimers();
    try {
      mocks.dnsLookup.mockReturnValueOnce(new Promise(() => undefined));
      const result = captureShot(env(), "https://preview.pages.dev/page");
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(result).resolves.toEqual({ png: expect.any(Uint8Array), authWalled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open (still renders) for a resolved address that is itself safe/public", async () => {
    mocks.dnsLookup.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
    const response = await handleShot(request("https://preview.pages.dev/page"), env());
    expect(response.status).toBe(200);
  });
});

describe("visual screenshot placeholder cards", () => {
  it("serves the loading spinner SVG for placeholder=loading", async () => {
    const response = await handleShot(shotRequest("placeholder=loading"), {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response.text()).toContain("Rendering preview");
  });

  it("serves the failed-deploy SVG for placeholder=failed", async () => {
    const response = await handleShot(shotRequest("placeholder=failed"), {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toContain("Preview deploy failed");
  });

  it("serves the auth-wall SVG for placeholder=auth", async () => {
    const response = await handleShot(shotRequest("placeholder=auth"), {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toContain("requires authentication");
  });

  it("does not treat an unknown placeholder value as a placeholder card", async () => {
    // An unrecognized placeholder falls through to the key/url modes; with neither present it is a bad url.
    const response = await handleShot(shotRequest("placeholder=unknown"), {} as Env);

    expect(response.status).toBe(400);
  });
});

describe("visual screenshot R2 key serve + traversal guard", () => {
  it("streams a stored PNG for a valid key inside the namespace", async () => {
    const png = new Uint8Array([10, 20, 30, 40]);
    const key = "loopover/shots/abc.png";
    const response = await handleShot(shotRequest(`key=${encodeURIComponent(key)}`), r2Env({ [key]: png }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("serves a .gif key with an image/gif content-type (#3612) — extension-derived, not stored httpMetadata", async () => {
    const gif = new Uint8Array([1, 2, 3, 4]);
    const key = "loopover/shots/abc.gif";
    const response = await handleShot(shotRequest(`key=${encodeURIComponent(key)}`), r2Env({ [key]: gif }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(gif);
  });

  it("returns 404 for a valid key that is absent from R2", async () => {
    const response = await handleShot(
      shotRequest(`key=${encodeURIComponent("loopover/shots/missing.png")}`),
      r2Env({}),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("rejects a key that traverses with ..", async () => {
    const response = await handleShot(
      shotRequest(`key=${encodeURIComponent("loopover/shots/../../etc/passwd")}`),
      r2Env({}),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("bad key");
  });

  it("rejects a key outside the namespace prefix", async () => {
    const response = await handleShot(
      shotRequest(`key=${encodeURIComponent("evil/shots/x.png")}`),
      r2Env({}),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("bad key");
  });

  it("honors a custom namespace option for the prefix check", async () => {
    const png = new Uint8Array([99]);
    const key = "customns/shots/x.png";
    const response = await handleShot(
      shotRequest(`key=${encodeURIComponent(key)}`),
      r2Env({ [key]: png }),
      { namespace: "customns" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });
});

// #9487: a browserless outage was logged but never COUNTED, so it was invisible in Prometheus while it
// degraded every screenshot to a dash cell -- and because the screenshot-table gate treats absent evidence as
// a close signal, that outage could close legitimate visual PRs before anyone noticed.
describe("visual capture result metric (#9487)", () => {
  it("counts a render failure, so a browserless outage is alertable rather than silent", async () => {
    resetMetrics();
    mocks.screenshot.mockRejectedValueOnce(new Error("Protocol error: Target closed"));

    await expect(captureShot(env(), "https://preview.pages.dev/page")).resolves.toEqual({ png: null, authWalled: false });

    expect(counterValue("loopover_visual_capture_total", { result: "error" })).toBe(1);
  });

});
