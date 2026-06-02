#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { get } from "node:https";

const root = process.cwd();
const packageName = "@jsonbored/gittensory-mcp";
const registryUrl = "https://registry.npmjs.org/@jsonbored%2fgittensory-mcp";
const sourceLatestPath = join(root, "apps/gittensory-ui/src/lib/mcp-package.ts");
const targets = [
  "README.md",
  "packages/gittensory-mcp/README.md",
  "apps/gittensory-ui/src",
].map((target) => join(root, target));

const latest = process.env.GITTENSORY_MCP_LATEST_VERSION ?? (await fetchLatestVersion());
const sourceLatest = readKnownLatestVersion(sourceLatestPath);
const failures = [];

if (sourceLatest !== latest) {
  failures.push(
    `apps/gittensory-ui/src/lib/mcp-package.ts: known latest ${sourceLatest} does not match npm dist-tags.latest ${latest}`,
  );
}

for (const file of targets.flatMap(collectSourceFiles)) {
  const label = relative(root, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/\bv0\.2(?:\.0)?\b/.test(line)) {
      failures.push(`${label}:${lineNumber}: stale visible v0.2 version text`);
    }
    if (/\b0\.2\.x\b/.test(line)) {
      failures.push(`${label}:${lineNumber}: stale 0.2.x package-version range`);
    }
    if (/\b0\.2\.0\b/.test(line) && !isMinimumSupportedContext(line)) {
      failures.push(`${label}:${lineNumber}: 0.2.0 is only allowed as an explicit minimum-supported compatibility floor`);
    }
    if (/@jsonbored\/gittensory-mcp(?:\s+|@)v?\d+\.\d+\.\d+/.test(line)) {
      failures.push(`${label}:${lineNumber}: hardcoded ${packageName} display version`);
    }
    if (/(?:npm (?:i|install) -g|npx -y)\s+@jsonbored\/gittensory-mcp(?!@)/.test(line)) {
      failures.push(`${label}:${lineNumber}: install command must use ${packageName}@latest or resolved npm latest`);
    }
    if (/args\s*=\s*\[.*"@jsonbored\/gittensory-mcp"/.test(line) || /"args":\s*\[.*"@jsonbored\/gittensory-mcp"/.test(line)) {
      failures.push(`${label}:${lineNumber}: MCP client args must use ${packageName}@latest or resolved npm latest`);
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`MCP UI version copy ok: npm latest ${latest}, scanned ${targets.length} target(s)`);

function collectSourceFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return isTextSource(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => {
    const next = join(path, entry);
    if (entry === "node_modules" || entry === "dist" || entry === ".vitepress" || entry === "coverage") return [];
    if (/routeTree\.gen\.ts$/.test(next) || /public\/openapi\.json$/.test(next)) return [];
    return collectSourceFiles(next);
  });
}

function isTextSource(path) {
  return /\.(md|ts|tsx|js|jsx|json)$/.test(path);
}

function isMinimumSupportedContext(line) {
  return /minimum[_ -]?supported|MCP_MINIMUM_SUPPORTED_VERSION|MINIMUM_SUPPORTED_MCP_VERSION|compatibility floor|API minimum|supportedVersionRange/i.test(line);
}

function readKnownLatestVersion(path) {
  const text = readFileSync(path, "utf8");
  const match = /MCP_PACKAGE_KNOWN_LATEST_VERSION\s*=\s*"([^"]+)"/.exec(text);
  if (!match) throw new Error("Could not find MCP_PACKAGE_KNOWN_LATEST_VERSION.");
  return match[1];
}

function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const request = get(registryUrl, { headers: { accept: "application/json" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`npm registry returned ${response.statusCode ?? "unknown"}`));
          return;
        }
        try {
          const latest = JSON.parse(body)?.["dist-tags"]?.latest;
          if (typeof latest !== "string" || !/^\d+\.\d+\.\d+$/.test(latest)) {
            reject(new Error("npm registry did not return a stable latest version"));
            return;
          }
          resolve(latest);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(8000, () => {
      request.destroy(new Error("npm registry timeout"));
    });
    request.on("error", reject);
  });
}
