import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spies shared by the module mock below. posthog-js's default export IS the `posthog`
// singleton (same as `import posthog from "posthog-js"` in real code), so the mock mirrors that
// shape rather than wrapping it -- analytics.ts destructures `{ default: posthog }` off its own
// dynamic import().
const mocks = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { init: mocks.init, capture: mocks.capture } }));

import {
  captureEvent,
  capturePageview,
  initAnalytics,
  isAnalyticsConfigured,
  resetAnalyticsForTest,
} from "./analytics";

const TOKEN = "phc_test_token";

beforeEach(() => {
  vi.clearAllMocks();
  // The SDK promise is memoized for the module's lifetime, so without this each test after the
  // first would reuse the previous one's already-resolved (or already-rejected) init.
  resetAnalyticsForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAnalyticsConfigured", () => {
  it("false when VITE_POSTHOG_PROJECT_TOKEN is unset or blank", () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
    expect(isAnalyticsConfigured()).toBe(false);
    // A whitespace-only build variable is a real failure mode -- an empty CI value that still
    // technically "exists" must read as unconfigured, not as a token made of spaces.
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "   ");
    expect(isAnalyticsConfigured()).toBe(false);
  });

  it("true when VITE_POSTHOG_PROJECT_TOKEN is set", () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);
    expect(isAnalyticsConfigured()).toBe(true);
  });
});

describe("analytics — unconfigured (no token)", () => {
  it("never loads or initializes the SDK from any entry point", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");

    initAnalytics();
    capturePageview("https://loopover.ai/docs");
    captureEvent("some_event", { a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The whole "zero cost when unconfigured" guarantee: no init, no capture, and because the
    // import is dynamic, the library is never even fetched.
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

describe("initAnalytics", () => {
  it("initializes exactly once across repeated calls (idempotent)", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);

    initAnalytics();
    initAnalytics();
    initAnalytics();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
  });

  it("initializes with the SPA-correct, Umami-parity configuration", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);

    initAnalytics();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));

    const [token, config] = mocks.init.mock.calls[0]!;
    expect(token).toBe(TOKEN);
    // Proxied first-party through this origin, never posthog.com directly.
    expect(config.api_host).toBe("/stats");
    expect(config.ui_host).toBe("https://us.posthog.com");
    // Pageviews are captured manually (the router subscription in __root.tsx) because an SPA's
    // auto-pageview only ever covers the first load...
    expect(config.capture_pageview).toBe(false);
    // ...but pageleave must be re-enabled explicitly, since posthog-js's default for it piggybacks
    // on capture_pageview and would otherwise silently go off too.
    expect(config.capture_pageleave).toBe(true);
    expect(config.capture_performance).toEqual({ web_vitals: true });
    // Parity with the Umami beacon, which checked navigator.doNotTrack itself.
    expect(config.respect_dnt).toBe(true);
    // Not "memory": that resets identity every reload and inflates unique visitors -- the exact
    // regression JSONbored/metagraphed#8210 had to correct. localStorage sets no cookie.
    expect(config.persistence).toBe("localStorage");
  });

  it("honors a VITE_POSTHOG_HOST override for local testing against a real host", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);
    vi.stubEnv("VITE_POSTHOG_HOST", "https://us.i.posthog.com");

    initAnalytics();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));

    expect(mocks.init.mock.calls[0]![1].api_host).toBe("https://us.i.posthog.com");
  });

  it("honors a VITE_POSTHOG_UI_HOST override", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);
    vi.stubEnv("VITE_POSTHOG_UI_HOST", "https://eu.posthog.com");

    initAnalytics();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));

    expect(mocks.init.mock.calls[0]![1].ui_host).toBe("https://eu.posthog.com");
  });
});

describe("capturePageview", () => {
  it("captures $pageview with the explicit url and the page title (Umami parity, #8299)", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);
    document.title = "LoopOver — Docs";

    capturePageview("https://loopover.ai/docs");
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1));

    expect(mocks.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: "https://loopover.ai/docs",
      // posthog-js has no built-in $title-equivalent, and the removed beacon did send `title`.
      page_title: "LoopOver — Docs",
    });
  });

  it("omits $current_url when no url is passed, letting posthog-js read the location itself", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);
    document.title = "LoopOver";

    capturePageview();
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1));

    const [event, properties] = mocks.capture.mock.calls[0]!;
    expect(event).toBe("$pageview");
    expect("$current_url" in properties).toBe(false);
    expect(properties.page_title).toBe("LoopOver");
  });
});

describe("captureEvent", () => {
  it("forwards the event name and properties verbatim", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);

    captureEvent("docs_search", { query_length: 4 });
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1));

    expect(mocks.capture).toHaveBeenCalledWith("docs_search", { query_length: 4 });
  });

  it("forwards an event with no properties", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", TOKEN);

    captureEvent("cta_clicked");
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1));

    expect(mocks.capture).toHaveBeenCalledWith("cta_clicked", undefined);
  });
});
