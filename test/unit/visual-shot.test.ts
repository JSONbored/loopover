import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureScrollFrames, captureShot, handleShot } from "../../src/review/visual/shot";

const mocks = vi.hoisted(() => ({
  finalUrl: "https://preview.pages.dev/page",
  screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
  abort: vi.fn(async () => undefined),
  continue: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  launch: vi.fn(),
  emulateMediaFeatures: vi.fn(async () => undefined),
  evaluate: vi.fn(),
  // captureScrollFrames' FIRST page.evaluate() call queries scrollHeight; every later call (scrollTo, the
  // settle delay) discards its return value — so only the first call's resolved value matters to the code
  // under test, regardless of exactly how many scroll/settle evaluate() calls happen after it.
  scrollHeight: 900,
  evaluateCallCount: 0,
}));

vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    launch: mocks.launch,
  },
}));

function env(): Env {
  return { BROWSER: {} } as Env;
}

function request(url: string): Request {
  return new Request(`https://api.example.test/gittensory/shot?url=${encodeURIComponent(url)}`);
}

function shotRequest(query: string): Request {
  return new Request(`https://api.example.test/gittensory/shot?${query}`);
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
      return mocks.evaluateCallCount === 1 ? mocks.scrollHeight : undefined;
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

  it("captures the FULL page, not just the viewport — before/after must show the same page position for a change however far down it is", async () => {
    mocks.finalUrl = "https://preview.pages.dev/page";

    await handleShot(request("https://preview.pages.dev/page"), env());

    expect(mocks.screenshot).toHaveBeenCalledWith({ type: "png", fullPage: true });
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
      return mocks.evaluateCallCount === 1 ? mocks.scrollHeight : undefined;
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
    const key = "gittensory/shots/abc.png";
    const response = await handleShot(shotRequest(`key=${encodeURIComponent(key)}`), r2Env({ [key]: png }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("serves a .gif key with an image/gif content-type (#3612) — extension-derived, not stored httpMetadata", async () => {
    const gif = new Uint8Array([1, 2, 3, 4]);
    const key = "gittensory/shots/abc.gif";
    const response = await handleShot(shotRequest(`key=${encodeURIComponent(key)}`), r2Env({ [key]: gif }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(gif);
  });

  it("returns 404 for a valid key that is absent from R2", async () => {
    const response = await handleShot(
      shotRequest(`key=${encodeURIComponent("gittensory/shots/missing.png")}`),
      r2Env({}),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("rejects a key that traverses with ..", async () => {
    const response = await handleShot(
      shotRequest(`key=${encodeURIComponent("gittensory/shots/../../etc/passwd")}`),
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
