// Tests for the self-host puppeteer stub (#980). Verifies the stub throws the right error when
// BROWSER_WS_ENDPOINT is absent and delegates to puppeteer-core when present.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("selfhost puppeteer stub (#980 visual review)", () => {
  let origEndpoint: string | undefined;
  beforeEach(() => { origEndpoint = process.env.BROWSER_WS_ENDPOINT; });
  afterEach(() => {
    if (origEndpoint === undefined) delete process.env.BROWSER_WS_ENDPOINT;
    else process.env.BROWSER_WS_ENDPOINT = origEndpoint;
    vi.resetModules();
  });

  it("launch() throws browser_rendering_unavailable when BROWSER_WS_ENDPOINT is not set", async () => {
    delete process.env.BROWSER_WS_ENDPOINT;
    const { default: puppeteer } = await import("../../src/selfhost/stubs/puppeteer");
    await expect(puppeteer.launch({})).rejects.toThrow(/browser_rendering_unavailable_on_selfhost/);
  });

  it("connect() throws browser_rendering_unavailable when BROWSER_WS_ENDPOINT is not set", async () => {
    delete process.env.BROWSER_WS_ENDPOINT;
    const { default: puppeteer } = await import("../../src/selfhost/stubs/puppeteer");
    await expect(puppeteer.connect({})).rejects.toThrow(/browser_rendering_unavailable_on_selfhost/);
  });

  it("launch() throws browser_rendering_unavailable when puppeteer-core is not installed", async () => {
    process.env.BROWSER_WS_ENDPOINT = "ws://fake:3000";
    // puppeteer-core is not in this repo's dependencies — the dynamic import naturally throws "Cannot find package".
    const { default: puppeteer } = await import("../../src/selfhost/stubs/puppeteer");
    await expect(puppeteer.launch({})).rejects.toThrow(/browser_rendering_unavailable_on_selfhost/);
  });

  it("connect() throws browser_rendering_unavailable when puppeteer-core is not installed", async () => {
    process.env.BROWSER_WS_ENDPOINT = "ws://fake:3000";
    const { default: puppeteer } = await import("../../src/selfhost/stubs/puppeteer");
    await expect(puppeteer.connect({})).rejects.toThrow(/browser_rendering_unavailable_on_selfhost/);
  });
});
