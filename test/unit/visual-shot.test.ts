import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureShot, handleShot } from "../../src/review/visual/shot";

const mocks = vi.hoisted(() => ({
  finalUrl: "https://preview.pages.dev/page",
  screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
  abort: vi.fn(async () => undefined),
  continue: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  launch: vi.fn(),
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
    mocks.launch.mockImplementation(async () => {
      let onRequest: ((request: ReturnType<typeof makeRequest>) => void) | undefined;
      return {
        newPage: async () => ({
          setRequestInterception: vi.fn(async () => undefined),
          on: vi.fn((event: string, callback: (request: ReturnType<typeof makeRequest>) => void) => {
            if (event === "request") onRequest = callback;
          }),
          setViewport: vi.fn(async () => undefined),
          goto: vi.fn(async (url: string) => {
            onRequest?.(makeRequest(url));
            if (mocks.finalUrl !== url) onRequest?.(makeRequest(mocks.finalUrl));
          }),
          url: vi.fn(() => mocks.finalUrl),
          screenshot: mocks.screenshot,
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
