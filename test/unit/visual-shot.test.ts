import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleShot } from "../../src/review/visual/shot";

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
});
