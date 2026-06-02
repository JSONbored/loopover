const siteOrigin = normalizeOrigin(process.env.GITTENSORY_SITE_ORIGIN ?? "https://gittensory.aethereal.dev");
const apiOrigin = normalizeOrigin(process.env.GITTENSORY_API_ORIGIN ?? "https://gittensory-api.aethereal.dev");

const siteRoutes = [
  "/",
  "/app",
  "/app/workbench",
  "/app/repos",
  "/app/runs",
  "/app/analytics",
  "/app/operator",
  "/app/commands",
  "/app/digest",
  "/api",
  "/roadmap",
  "/changelog",
  "/extension",
  "/docs",
  "/docs/quickstart",
  "/docs/mcp-clients",
];

await main();

async function main() {
  const checks = [];
  for (const route of siteRoutes) checks.push(checkStatus(`${siteOrigin}${route}`, 200, `UI ${route}`));
  checks.push(checkStatus(`${siteOrigin}/openapi.json`, 200, "UI OpenAPI artifact", { contentType: /application\/json/i }));
  checks.push(checkStatus(`${siteOrigin}/downloads/gittensory-extension.zip`, 200, "extension zip", { contentType: /application\/zip/i }));
  checks.push(checkText(`${siteOrigin}/robots.txt`, "Sitemap: https://gittensory.aethereal.dev/sitemap.xml", "robots sitemap directive"));
  checks.push(checkStatus(`${siteOrigin}/sitemap.xml`, 200, "sitemap", { contentType: /application\/xml/i }));
  checks.push(checkStatus(`${siteOrigin}/CNAME`, 404, "retired GitHub Pages CNAME"));

  checks.push(checkJson(`${apiOrigin}/health`, "API health", (json) => json.status === "ok" && json.minMcpVersion === "0.4.0" && json.latestRecommendedMcpVersion === "0.4.0"));
  checks.push(
    checkJson(
      `${apiOrigin}/v1/mcp/compatibility`,
      "MCP compatibility",
      (json) => json.status === "ok" && json.mcp?.minimumSupportedVersion === "0.4.0" && json.mcp?.latestPackageVersion === "0.4.0",
    ),
  );
  checks.push(checkJson(`${apiOrigin}/v1/auth/session`, "signed-out session", (json) => json.status === "signed_out"));
  checks.push(checkJson(`${apiOrigin}/v1/repos`, "protected API auth", (json, response) => response.status === 401 && json.error === "unauthorized", { expectedStatus: 401 }));
  checks.push(checkRedirect(`${apiOrigin}/v1/auth/github/start`, "GitHub OAuth start", /^https:\/\/github\.com\/login\/oauth\/authorize\?/));
  checks.push(checkCors(true));
  checks.push(checkCors(false));

  const results = await Promise.allSettled(checks);
  const failures = results
    .map((result) => (result.status === "rejected" ? result.reason : null))
    .filter(Boolean);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`production smoke failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`production smoke passed for ${siteOrigin} and ${apiOrigin}`);
}

async function checkStatus(url, expectedStatus, label, options = {}) {
  const response = await fetchWithTimeout(url);
  assert(response.status === expectedStatus, `${label} expected ${expectedStatus}, got ${response.status}`);
  if (options.contentType) assert(options.contentType.test(response.headers.get("content-type") ?? ""), `${label} had unexpected content-type ${response.headers.get("content-type")}`);
}

async function checkText(url, expectedText, label) {
  const response = await fetchWithTimeout(url);
  assert(response.ok, `${label} expected success, got ${response.status}`);
  const text = await response.text();
  assert(text.includes(expectedText), `${label} missing ${expectedText}`);
}

async function checkJson(url, label, predicate, options = {}) {
  const response = await fetchWithTimeout(url);
  const expectedStatus = options.expectedStatus ?? 200;
  assert(response.status === expectedStatus, `${label} expected ${expectedStatus}, got ${response.status}`);
  const json = await response.json();
  assert(predicate(json, response), `${label} returned unexpected JSON ${JSON.stringify(json).slice(0, 500)}`);
}

async function checkRedirect(url, label, locationPattern) {
  const response = await fetchWithTimeout(url, { redirect: "manual" });
  assert(response.status === 302, `${label} expected 302, got ${response.status}`);
  const location = response.headers.get("location") ?? "";
  assert(locationPattern.test(location), `${label} redirected to unexpected location ${location}`);
}

async function checkCors(allowed) {
  const origin = allowed ? siteOrigin : "https://evil.example";
  const response = await fetchWithTimeout(`${apiOrigin}/v1/auth/session`, { headers: { origin } });
  const allowOrigin = response.headers.get("access-control-allow-origin");
  const allowCredentials = response.headers.get("access-control-allow-credentials");
  if (allowed) {
    assert(allowOrigin === siteOrigin, `trusted CORS origin was not allowed: ${allowOrigin}`);
    assert(allowCredentials === "true", `trusted CORS credentials were not allowed: ${allowCredentials}`);
    return;
  }
  assert(!allowOrigin, `untrusted CORS origin was allowed: ${allowOrigin}`);
  assert(!allowCredentials, `untrusted CORS credentials were allowed: ${allowCredentials}`);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        "user-agent": "gittensory-production-smoke",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOrigin(value) {
  const url = new URL(value);
  return url.origin;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
