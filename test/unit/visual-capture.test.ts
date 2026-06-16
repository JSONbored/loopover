import { describe, expect, it } from "vitest";
import {
  captureObjectKey,
  CaptureArtifact,
  CapturePage,
  CaptureSide,
  DEFAULT_ROUTES,
  DEFAULT_VIEWPORTS,
  DETERMINISTIC_INIT_SCRIPT,
  DETERMINISTIC_STYLE,
  FIXED_EPOCH_MS,
  FONTS_READY_EXPRESSION,
  joinUrl,
  planCaptures,
  routeSlug,
  runVisualCapture,
  Viewport,
} from "../../src/visual/capture";

/** Records every interaction so tests can assert navigation order, settling, and shot wiring. A goto to
 *  a route in `failRoutes` resolves to the given status (to drive the failure branch); everything else
 *  returns 200. screenshot() returns deterministic bytes derived from the call sequence. */
class FakePage implements CapturePage {
  goto_urls: string[] = [];
  initScripts: string[] = [];
  styleContents: string[] = [];
  evaluated: string[] = [];
  selectors: string[] = [];
  loadStates: string[] = [];
  shots = 0;
  closed = false;
  constructor(
    readonly viewport: Viewport,
    readonly statusFor: (url: string) => number | null,
    readonly recorder: { gotoOrder: string[]; initBeforeGoto: boolean[] },
  ) {}
  async addInitScript(script: string): Promise<void> {
    this.initScripts.push(script);
  }
  async goto(url: string): Promise<{ status: number } | null> {
    this.recorder.gotoOrder.push(url);
    this.recorder.initBeforeGoto.push(this.initScripts.length > 0);
    this.goto_urls.push(url);
    const status = this.statusFor(url);
    return status === null ? null : { status };
  }
  async waitForLoadState(state: "networkidle"): Promise<void> {
    this.loadStates.push(state);
  }
  async waitForSelector(selector: string): Promise<void> {
    this.selectors.push(selector);
  }
  async evaluate(expression: string): Promise<unknown> {
    this.evaluated.push(expression);
    return "ready";
  }
  async addStyleTag(options: { content: string }): Promise<void> {
    this.styleContents.push(options.content);
  }
  async screenshot(): Promise<Uint8Array> {
    this.shots += 1;
    return new Uint8Array([this.viewport.width % 256, this.shots]);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeBrowser(statusFor: (url: string) => number | null = () => 200) {
  const pages: FakePage[] = [];
  const recorder = { gotoOrder: [] as string[], initBeforeGoto: [] as boolean[] };
  const browser = {
    async newPage(viewport: Viewport) {
      const page = new FakePage(viewport, statusFor, recorder);
      pages.push(page);
      return page;
    },
  };
  return { browser, pages, recorder };
}

describe("routeSlug", () => {
  it("maps the root route to 'root'", () => {
    expect(routeSlug("/")).toBe("root");
    expect(routeSlug("")).toBe("root");
    expect(routeSlug("///")).toBe("root");
  });
  it("slugifies nested and non-alphanumeric routes", () => {
    expect(routeSlug("/app/repos")).toBe("app-repos");
    expect(routeSlug("/app/runs/")).toBe("app-runs");
    expect(routeSlug("/docs?tab=a&x=1")).toBe("docs-tab-a-x-1");
  });
});

describe("captureObjectKey", () => {
  it("builds a stable key and defaults the prefix", () => {
    expect(captureObjectKey({ viewport: "desktop", route: "/app/repos", side: "before" })).toBe("visual-review/desktop/app-repos.before.png");
    expect(captureObjectKey({ viewport: "mobile", route: "/", side: "after" })).toBe("visual-review/mobile/root.after.png");
  });
  it("honours a custom prefix", () => {
    expect(captureObjectKey({ prefix: "octo/demo/7/sha", viewport: "desktop", route: "/", side: "before" })).toBe("octo/demo/7/sha/desktop/root.before.png");
  });
  it("before/after keys for a route+viewport differ only by side", () => {
    const before = captureObjectKey({ viewport: "desktop", route: "/roadmap", side: "before" });
    const after = captureObjectKey({ viewport: "desktop", route: "/roadmap", side: "after" });
    expect(before.replace(".before.", ".after.")).toBe(after);
  });
});

describe("joinUrl", () => {
  it("joins origin and route handling slashes", () => {
    expect(joinUrl("https://x.dev", "/")).toBe("https://x.dev/");
    expect(joinUrl("https://x.dev/", "")).toBe("https://x.dev/");
    expect(joinUrl("https://x.dev/", "/app/repos")).toBe("https://x.dev/app/repos");
    expect(joinUrl("https://x.dev", "app")).toBe("https://x.dev/app");
  });
});

describe("planCaptures", () => {
  it("produces a matching before/after pair for every route+viewport", () => {
    const plan = planCaptures(["/", "/app"], DEFAULT_VIEWPORTS);
    expect(plan).toHaveLength(2 * 2 * 2); // viewports * sides * routes
    for (const viewport of DEFAULT_VIEWPORTS) {
      for (const route of ["/", "/app"]) {
        const sides = plan.filter((p) => p.viewport.name === viewport.name && p.route === route).map((p) => p.side).sort();
        expect(sides).toEqual<CaptureSide[]>(["after", "before"]);
      }
    }
  });
});

describe("deterministic settling sources", () => {
  it("disables animation, transition, caret, and scrollbars", () => {
    expect(DETERMINISTIC_STYLE).toContain("animation:none!important");
    expect(DETERMINISTIC_STYLE).toContain("transition:none!important");
    expect(DETERMINISTIC_STYLE).toContain("caret-color:transparent!important");
    expect(DETERMINISTIC_STYLE).toContain("scrollbar-width:none!important");
  });
  it("freezes the clock and seeds Math.random", () => {
    expect(DETERMINISTIC_INIT_SCRIPT).toContain(String(FIXED_EPOCH_MS));
    expect(DETERMINISTIC_INIT_SCRIPT).toContain("static now()");
    expect(DETERMINISTIC_INIT_SCRIPT).toContain("Math.random");
    expect(FONTS_READY_EXPRESSION).toContain("document.fonts");
  });
});

describe("runVisualCapture", () => {
  it("captures matching before/after PNG pairs for every route and viewport (defaults)", async () => {
    const { browser, pages } = fakeBrowser();
    const artifacts = await runVisualCapture(browser, { baseUrl: "https://base.dev", headUrl: "https://head.dev" });

    const expected = DEFAULT_ROUTES.length * DEFAULT_VIEWPORTS.length * 2;
    expect(artifacts).toHaveLength(expected);

    // Every (route, viewport) has exactly one before and one after, keyed deterministically.
    for (const viewport of DEFAULT_VIEWPORTS) {
      for (const route of DEFAULT_ROUTES) {
        const matches = artifacts.filter((a) => a.viewport === viewport.name && a.route === route);
        expect(matches.map((m) => m.side).sort()).toEqual(["after", "before"]);
        const before = matches.find((m) => m.side === "before")!;
        const after = matches.find((m) => m.side === "after")!;
        expect(before.key).toBe(captureObjectKey({ viewport: viewport.name, route, side: "before" }));
        expect(after.key).toBe(captureObjectKey({ viewport: viewport.name, route, side: "after" }));
        expect(before.bytes).toBeInstanceOf(Uint8Array);
      }
    }

    // One page per (viewport, side); each gets the init script before any navigation and is closed.
    expect(pages).toHaveLength(DEFAULT_VIEWPORTS.length * 2);
    for (const page of pages) {
      expect(page.initScripts).toEqual([DETERMINISTIC_INIT_SCRIPT]);
      expect(page.closed).toBe(true);
      // settling style + fonts wait + networkidle wait happen once per route on the page.
      expect(page.styleContents.every((c) => c === DETERMINISTIC_STYLE)).toBe(true);
      expect(page.styleContents).toHaveLength(DEFAULT_ROUTES.length);
      expect(page.evaluated.every((e) => e === FONTS_READY_EXPRESSION)).toBe(true);
      expect(page.loadStates).toEqual(new Array(DEFAULT_ROUTES.length).fill("networkidle"));
    }
  });

  it("produces stable, identical keys across repeated runs", async () => {
    const run = async () => (await runVisualCapture(fakeBrowser().browser, { baseUrl: "b", headUrl: "h", routes: ["/", "/app"], viewports: DEFAULT_VIEWPORTS })).map((a) => a.key);
    expect(await run()).toEqual(await run());
  });

  it("routes 'before' to baseUrl and 'after' to headUrl", async () => {
    const { browser, recorder } = fakeBrowser();
    await runVisualCapture(browser, { baseUrl: "https://base.dev", headUrl: "https://head.dev", routes: ["/app"], viewports: [{ name: "desktop", width: 1440, height: 900 }] });
    expect(recorder.gotoOrder).toEqual(["https://base.dev/app", "https://head.dev/app"]);
    expect(recorder.initBeforeGoto.every(Boolean)).toBe(true);
  });

  it("waits for the hydration selector when provided", async () => {
    const { browser, pages } = fakeBrowser();
    await runVisualCapture(browser, { baseUrl: "b", headUrl: "h", routes: ["/"], viewports: [{ name: "desktop", width: 1440, height: 900 }], hydrationSelector: "#app-ready" });
    expect(pages.every((p) => p.selectors.includes("#app-ready") || p.selectors.length === 1)).toBe(true);
    expect(pages[0]!.selectors).toEqual(["#app-ready"]);
  });

  it("skips the hydration wait when no selector is given", async () => {
    const { browser, pages } = fakeBrowser();
    await runVisualCapture(browser, { baseUrl: "b", headUrl: "h", routes: ["/"], viewports: [{ name: "desktop", width: 1440, height: 900 }] });
    expect(pages.every((p) => p.selectors.length === 0)).toBe(true);
  });

  it("honours a custom key prefix and navigation timeout", async () => {
    const { browser } = fakeBrowser();
    const artifacts = await runVisualCapture(browser, { baseUrl: "b", headUrl: "h", routes: ["/"], viewports: [{ name: "desktop", width: 1, height: 1 }], keyPrefix: "octo/demo/7/sha", navigationTimeoutMs: 5_000 });
    expect(artifacts[0]!.key).toBe("octo/demo/7/sha/desktop/root.before.png");
  });

  it("throws and still closes the page on an HTTP error status", async () => {
    const { browser, pages } = fakeBrowser((url) => (url.includes("/broken") ? 500 : 200));
    await expect(
      runVisualCapture(browser, { baseUrl: "https://base.dev", headUrl: "h", routes: ["/broken"], viewports: [{ name: "desktop", width: 1, height: 1 }] }),
    ).rejects.toThrow(/status 500/);
    expect(pages[0]!.closed).toBe(true);
    expect(pages[0]!.shots).toBe(0);
  });

  it("throws when navigation returns no response", async () => {
    const { browser } = fakeBrowser(() => null);
    await expect(
      runVisualCapture(browser, { baseUrl: "b", headUrl: "h", routes: ["/"], viewports: [{ name: "desktop", width: 1, height: 1 }] }),
    ).rejects.toThrow(/status none/);
  });
});

describe("exported defaults", () => {
  it("exposes desktop + mobile viewports and a non-empty route list", () => {
    expect(DEFAULT_VIEWPORTS.map((v) => v.name)).toEqual(["desktop", "mobile"]);
    expect(DEFAULT_ROUTES).toContain("/");
    expect(DEFAULT_ROUTES.length).toBeGreaterThan(0);
  });
  it("re-exports the CaptureArtifact type shape via a sample object", () => {
    const sample: CaptureArtifact = { side: "before", route: "/", viewport: "desktop", key: "k", bytes: new Uint8Array() };
    expect(sample.side).toBe("before");
  });
});
