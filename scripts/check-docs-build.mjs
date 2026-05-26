#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "site/.vitepress/dist");
const indexPath = join(dist, "index.html");
const expectUmami = process.env.GITTENSORY_EXPECT_UMAMI === "1";
const expectedScriptUrl = process.env.GITTENSORY_UMAMI_SCRIPT_URL;
const expectedWebsiteId = process.env.GITTENSORY_UMAMI_WEBSITE_ID;
const expectedDomains = process.env.GITTENSORY_UMAMI_DOMAINS ?? "gittensory.aethereal.dev";
const failures = [];

if (!existsSync(indexPath)) {
  failures.push("site/.vitepress/dist/index.html is missing; run npm run docs:build first.");
} else {
  const html = readFileSync(indexPath, "utf8");
  if (!html.includes("gtn-version-pill")) failures.push("built docs are missing the MCP version pill markup.");
  if (!html.includes("MCP")) failures.push("built docs are missing MCP version text.");
  if (!html.includes("/images/gittensor-home-signal.webp")) failures.push("built docs are missing the Gittensor context image.");
}

if (!existsSync(join(dist, "images/gittensor-home-signal.webp"))) {
  failures.push("built docs are missing the Gittensor context image asset.");
}

const builtFiles = existsSync(dist) ? collect(dist).filter((file) => /\.(html|js)$/.test(file)) : [];
const builtText = builtFiles.map((file) => readFileSync(file, "utf8")).join("\n");

if (!builtText.includes("registry.npmjs.org") || !builtText.includes("@jsonbored%2fgittensory-mcp")) {
  failures.push("built docs are missing the npm registry fetch for the MCP version widget.");
}

if (expectUmami) {
  if (!expectedScriptUrl || !expectedWebsiteId) {
    failures.push("GITTENSORY_EXPECT_UMAMI=1 requires GITTENSORY_UMAMI_SCRIPT_URL and GITTENSORY_UMAMI_WEBSITE_ID.");
  } else {
    if (!builtText.includes(expectedScriptUrl)) failures.push("built docs are missing the configured Umami script URL.");
    if (!builtText.includes(`data-website-id="${expectedWebsiteId}"`)) failures.push("built docs are missing the configured Umami website ID.");
    if (!builtText.includes(`data-domains="${expectedDomains}"`)) failures.push("built docs are missing the configured Umami domain list.");
    if (!builtText.includes('data-do-not-track="true"')) failures.push("built docs are missing the Umami do-not-track attribute.");
    if (!builtText.includes('data-exclude-search="true"')) failures.push("built docs are missing the Umami search exclusion attribute.");
    if (!builtText.includes('data-exclude-hash="true"')) failures.push("built docs are missing the Umami hash exclusion attribute.");
  }
} else if (builtText.includes("data-website-id=")) {
  failures.push("built docs include analytics without GITTENSORY_EXPECT_UMAMI=1.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`checked built docs (${builtFiles.length} file(s))`);

function collect(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) => collect(join(path, entry)));
}
