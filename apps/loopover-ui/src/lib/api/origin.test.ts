import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

// Fresh module per call so the module-level "warned once" flag resets between cases.
async function loadGetApiOrigin() {
  vi.resetModules();
  return (await import("@/lib/api/origin")).getApiOrigin;
}

describe("getApiOrigin (#7534)", () => {
  it("returns the configured origin with trailing slashes trimmed, and does not warn", async () => {
    vi.stubEnv("VITE_LOOPOVER_API_ORIGIN", "https://my-api.example.com//");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getApiOrigin = await loadGetApiOrigin();
    expect(getApiOrigin()).toBe("https://my-api.example.com");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when explicitly pointed at the default origin on purpose", async () => {
    // Gate is "env var unset", not "resolved value equals default" — a deliberate hosted-origin config
    // must stay silent.
    vi.stubEnv("VITE_LOOPOVER_API_ORIGIN", "https://api.loopover.ai");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getApiOrigin = await loadGetApiOrigin();
    expect(getApiOrigin()).toBe("https://api.loopover.ai");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the default origin and warns exactly once when unconfigured", async () => {
    vi.stubEnv("VITE_LOOPOVER_API_ORIGIN", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getApiOrigin = await loadGetApiOrigin();
    expect(getApiOrigin()).toBe("https://api.loopover.ai");
    getApiOrigin();
    getApiOrigin();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("VITE_LOOPOVER_API_ORIGIN");
  });
});
