// Self-host replacement for @cloudflare/puppeteer (#980). When BROWSER_WS_ENDPOINT is set, connects to an
// external Chrome-compatible browser (e.g. a `browserless/chrome` sidecar) via puppeteer-core's WebSocket
// connect API — this makes the /gittensory/shot on-demand render endpoint fully functional. When the env var
// is absent, the functions throw so the caller's `if (!env.BROWSER)` guard (in shot.ts) short-circuits first.
// Install: add `puppeteer-core` to package deps + set BROWSER_WS_ENDPOINT (or set INSTALL_VISUAL_REVIEW=true
// in the Dockerfile and point at a `browserless/chrome:latest` sidecar).

/** Connect to the external browser, using puppeteer-core loaded at runtime (avoids bundling ~20 MB of
 *  puppeteer's internals when visual review is disabled). Throws a clear error if not installed. */
async function connectBrowser(): Promise<unknown> {
  const wsEndpoint = process.env.BROWSER_WS_ENDPOINT;
  if (!wsEndpoint) throw new Error("browser_rendering_unavailable_on_selfhost: set BROWSER_WS_ENDPOINT to a browserless/chrome ws:// URL");
  try {
    // @ts-expect-error -- puppeteer-core is an optional runtime dep (INSTALL_VISUAL_REVIEW=true), not in project deps
    const { default: puppeteer } = (await import("puppeteer-core")) as { default: { connect(o: { browserWSEndpoint: string }): unknown } };
    /* v8 ignore next -- only reachable when puppeteer-core is installed (INSTALL_VISUAL_REVIEW=true builds) */
    return puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  } catch (e) {
    if (e instanceof Error && e.message.includes("Cannot find package")) {
      throw new Error("browser_rendering_unavailable_on_selfhost: install puppeteer-core or build with INSTALL_VISUAL_REVIEW=true");
    }
    /* v8 ignore next -- only reachable when puppeteer-core is installed but connect() itself throws */
    throw e;
  }
}

export default {
  /** Drop-in for @cloudflare/puppeteer's launch(browserWorker). Ignores the CF binding arg and connects via WS. */
  launch: (_browserWorkerHint: unknown): Promise<unknown> => connectBrowser(),
  connect: (_opts: unknown): Promise<unknown> => connectBrowser(),
};
