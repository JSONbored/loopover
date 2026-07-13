const siteOrigin = new URL(process.env.GITTENSORY_SITE_ORIGIN ?? "https://loopover.ai").origin;
const routes = ["/", "/app", "/app/workbench", "/app/repos", "/app/runs", "/app/analytics", "/app/operator", "/app/commands", "/app/digest", "/api", "/roadmap", "/changelog", "/extension", "/docs"];

const playwright = await import("playwright").catch(() => null);
if (!playwright) {
  console.error("Browser smoke requires Playwright in the caller environment. Run npm install first, then npm run test:smoke:browser:install.");
  process.exit(1);
}

const browser = await playwright.chromium.launch({ headless: process.env.HEADFUL !== "1" }).catch((error) => {
  throw new Error(`Chromium launch failed. Run npm run test:smoke:browser:install first. ${error instanceof Error ? error.message : String(error)}`);
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => {
  consoleErrors.push(error.message);
});

try {
  for (const route of routes) {
    const response = await page.goto(`${siteOrigin}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!response || response.status() !== 200) throw new Error(`${route} returned ${response?.status() ?? "no response"}`);
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
    await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
    const bodyText = await page.locator("body").innerText({ timeout: 10_000 });
    if (!bodyText.trim()) throw new Error(`${route} rendered an empty body`);
  }
  if (consoleErrors.length > 0) throw new Error(`browser console errors:\n${consoleErrors.join("\n")}`);
  console.log(`browser smoke passed for ${siteOrigin}`);
} finally {
  await browser.close();
}
