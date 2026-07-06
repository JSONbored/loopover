import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScrollFrames } from "../../src/review/visual/shot";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: mocks.launch },
}));

function envWithBrowser(): Env {
  return { BROWSER: {} } as Env;
}

afterEach(() => {
  mocks.launch.mockReset();
  vi.useRealTimers();
});

describe("captureScrollFrames operation timeout", () => {
  it("captures frames when page-realm scroll operations settle normally", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const screenshot = new Uint8Array([1, 2, 3]);
    const page = {
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      setViewport: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://preview.example.com/app"),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(700)
        .mockResolvedValueOnce(undefined),
      screenshot: vi.fn().mockResolvedValue(screenshot),
    };
    mocks.launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue(page), close });

    const result = await captureScrollFrames(envWithBrowser(), "https://preview.example.com/app", { width: 100, height: 900 });

    expect(result).toEqual({ frames: [screenshot], authWalled: false });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.screenshot).toHaveBeenCalledWith({ type: "png", fullPage: false });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: bounds a contributor-controlled page-realm scroll hang and closes the browser", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const page = {
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      setViewport: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://preview.example.com/app"),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(1_800)
        .mockReturnValueOnce(new Promise<never>(() => undefined)),
      screenshot: vi.fn(),
    };
    mocks.launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue(page), close });

    const started = Date.now();
    const result = await captureScrollFrames(envWithBrowser(), "https://preview.example.com/app", { width: 100, height: 900 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toEqual({ frames: [], authWalled: false });
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  }, 7_000);
});
