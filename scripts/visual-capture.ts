#!/usr/bin/env tsx
// #581 (epic #577, roadmap #525): Playwright before/after capture runner.
//
// Thin Chromium adapter around the pure core in src/visual/capture.ts. It reuses the launch pattern from
// scripts/smoke-ui-browser.mjs (dynamic playwright import + headless chromium) and adapts a Playwright
// `Page` to the core's narrow `CapturePage` interface, then writes the resulting before/after PNG pairs
// to disk. The interesting, testable logic (viewports, settling, planning, key naming, orchestration)
// lives in the core and is unit-tested; this script is just wiring and is intentionally kept out of the
// Worker bundle and the coverage surface.
//
// Usage:
//   BASE_URL=https://base.example HEAD_URL=https://head.example npm run visual:capture
//   (defaults both sides to the production origin so it doubles as a capture smoke test.)
// Prereqs: `npm install` then `npm run test:smoke:browser:install` (Chromium).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROUTES, DEFAULT_VIEWPORTS, runVisualCapture, type CaptureBrowser, type CapturePage, type Viewport } from "../src/visual/capture";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOrigin = new URL(process.env.GITTENSORY_SITE_ORIGIN ?? "https://gittensory.aethereal.dev").origin;
const baseUrl = new URL(process.env.BASE_URL ?? defaultOrigin).origin;
const headUrl = new URL(process.env.HEAD_URL ?? defaultOrigin).origin;
const outDir = resolve(root, process.env.VISUAL_CAPTURE_OUT ?? ".wrangler/visual-capture");
const hydrationSelector = process.env.VISUAL_CAPTURE_HYDRATION_SELECTOR;

const playwright = await import("playwright").catch(() => null);
if (!playwright) {
  console.error("Visual capture requires Playwright in the caller environment. Run `npm install`, then `npm run test:smoke:browser:install`.");
  process.exit(1);
}

const browser = await playwright.chromium.launch({ headless: process.env.HEADFUL !== "1" }).catch((error: unknown) => {
  throw new Error(`Chromium launch failed. Run \`npm run test:smoke:browser:install\` first. ${error instanceof Error ? error.message : String(error)}`);
});

/** Adapt a Playwright BrowserContext/Page to the core's CaptureBrowser. A fresh context per page keeps
 *  viewport + storage isolated, mirroring the smoke script's single-context-per-run isolation intent. */
const adapter: CaptureBrowser = {
  async newPage(viewport: Viewport): Promise<CapturePage> {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    const page = await context.newPage();
    return {
      addInitScript: (script: string) => page.addInitScript(script),
      goto: async (url: string, options: { waitUntil: "networkidle"; timeout: number }) => {
        const response = await page.goto(url, options);
        return response ? { status: response.status() } : null;
      },
      waitForLoadState: (state: "networkidle", options: { timeout: number }) => page.waitForLoadState(state, options),
      waitForSelector: async (selector: string, options: { timeout: number }) => {
        await page.waitForSelector(selector, options);
      },
      evaluate: (expression: string) => page.evaluate(expression),
      addStyleTag: async (options: { content: string }) => {
        await page.addStyleTag(options);
      },
      screenshot: (options: { fullPage: boolean }) => page.screenshot(options),
      close: () => context.close(),
    };
  },
};

try {
  const artifacts = await runVisualCapture(adapter, {
    baseUrl,
    headUrl,
    routes: DEFAULT_ROUTES,
    viewports: DEFAULT_VIEWPORTS,
    ...(hydrationSelector ? { hydrationSelector } : {}),
  });
  for (const artifact of artifacts) {
    const target = resolve(outDir, artifact.key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.bytes);
  }
  const pairs = artifacts.length / 2;
  console.log(`visual capture wrote ${artifacts.length} PNGs (${pairs} before/after pairs) to ${outDir}`);
  console.log(`  base=${baseUrl} head=${headUrl} viewports=${DEFAULT_VIEWPORTS.map((v) => v.name).join(",")} routes=${DEFAULT_ROUTES.length}`);
} finally {
  await browser.close();
}
