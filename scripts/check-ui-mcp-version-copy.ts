#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@loopover/mcp";
const registryUrl = "https://registry.npmjs.org/@loopover%2fmcp";

// Single source of truth for the version literals this scan enforces: the same UI module the known-latest
// check already reads. The minimum-supported floor is derived from MCP_MINIMUM_SUPPORTED_VERSION rather than
// hardcoded here, so a floor bump can't silently leave this deterministic drift-detector aimed at a stale
// version (its literals had frozen several majors behind the real floor — #6292).
export const SOURCE_LATEST_PATH = "apps/loopover-ui/src/lib/mcp-package.ts";
export const SCAN_TARGETS = [
  "README.md",
  "packages/loopover-mcp/README.md",
  "apps/loopover-ui/src",
  // The fumadocs-mdx docs content (5003fabe) lives in a sibling directory OUTSIDE src/; check-docs-drift.mjs was
  // updated for the move but this scanner was not, leaving 10 real .mdx files with @loopover/mcp install snippets
  // unscanned for stale-version drift (#7093).
  "apps/loopover-ui/content",
];

export type StaleVersionMatchers = {
  floorVersion: string;
  minorLabel: string;
  visibleVersion: RegExp;
  versionRange: RegExp;
  floor: RegExp;
};

async function main() {
  const root = process.cwd();
  const sourceLatestPath = join(root, SOURCE_LATEST_PATH);
  const targets = SCAN_TARGETS.map((target) => join(root, target));

  // The live npm-registry check is BEST-EFFORT: a transient registry blip must not fail CI, because a red
  // required check one-shot-closes a contributor PR. Set LOOPOVER_MCP_LATEST_VERSION to make it fully
  // offline/deterministic. The deterministic stale-version-string scan below always runs regardless.
  let latest = process.env.LOOPOVER_MCP_LATEST_VERSION ?? null;
  let latestSkipReason = null;
  if (!latest) {
    try {
      latest = await fetchLatestVersion();
    } catch (error) {
      latestSkipReason = error instanceof Error ? error.message : "unknown error";
    }
  }
  const sourceLatest = readKnownLatestVersion(sourceLatestPath);
  const matchers = buildStaleVersionMatchers(readMinimumSupportedVersion(sourceLatestPath));
  const failures: string[] = [];

  // --write: self-heal the known-latest fallback instead of failing, so keeping it in sync with npm is a
  // scheduled bot commit (see .github/workflows/mcp-ui-version-sync.yml), never a manual edit (#6580). CI's
  // own invocation never passes --write, so a contributor PR still gets a hard failure on real drift.
  const write = process.argv.includes("--write");
  if (latest && sourceLatest !== latest) {
    if (write) {
      writeKnownLatestVersion(sourceLatestPath, latest);
      console.log(`${SOURCE_LATEST_PATH}: updated known latest ${sourceLatest} -> ${latest}`);
    } else {
      failures.push(`${SOURCE_LATEST_PATH}: known latest ${sourceLatest} does not match npm dist-tags.latest ${latest}`);
    }
  } else if (!latest) {
    console.warn(
      `::warning::skipped the npm dist-tag drift check (registry unavailable: ${latestSkipReason}); set LOOPOVER_MCP_LATEST_VERSION to enforce it offline`,
    );
  }

  for (const file of targets.flatMap(collectSourceFiles)) {
    const label = relative(root, file);
    const text = readFileSync(file, "utf8");
    failures.push(...collectVersionCopyFailures({ label, text, matchers }));
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(`MCP UI version copy ok: npm latest ${latest ?? "unchecked"}, minimum floor ${matchers.floorVersion}, scanned ${targets.length} target(s)`);
}

export function collectVersionCopyFailures({ label, text, matchers }: { label: string; text: string; matchers: StaleVersionMatchers }): string[] {
  const failures: string[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (matchers.visibleVersion.test(line)) {
      failures.push(`${label}:${lineNumber}: stale visible v${matchers.minorLabel} version text`);
    }
    if (matchers.versionRange.test(line)) {
      failures.push(`${label}:${lineNumber}: stale ${matchers.minorLabel}.x package-version range`);
    }
    if (matchers.floor.test(line) && !isMinimumSupportedContext(line)) {
      failures.push(`${label}:${lineNumber}: ${matchers.floorVersion} is only allowed as an explicit minimum-supported compatibility floor`);
    }
    if (/@loopover\/mcp(?:\s+|@)v?\d+\.\d+\.\d+/.test(line)) {
      failures.push(`${label}:${lineNumber}: hardcoded ${packageName} display version`);
    }
    if (/(?:npm (?:i|install) -g|npx -y)\s+@loopover\/mcp(?!@)/.test(line)) {
      failures.push(`${label}:${lineNumber}: install command must use ${packageName}@latest or resolved npm latest`);
    }
    if (/args\s*=\s*\[.*"@loopover\/mcp"/.test(line) || /"args":\s*\[.*"@loopover\/mcp"/.test(line)) {
      failures.push(`${label}:${lineNumber}: MCP client args must use ${packageName}@latest or resolved npm latest`);
    }
  });

  return failures;
}

export function collectSourceFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return isTextSource(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => {
    const next = join(path, entry);
    if (entry === "node_modules" || entry === "dist" || entry === ".vitepress" || entry === "coverage") return [];
    if (/routeTree\.gen\.ts$/.test(next) || /public\/openapi\.json$/.test(next)) return [];
    return collectSourceFiles(next);
  });
}

export function isTextSource(path: string): boolean {
  return /\.(md|mdx|ts|tsx|js|jsx|json)$/.test(path);
}

export function isMinimumSupportedContext(line: string): boolean {
  return /minimum[_ -]?supported|MCP_MINIMUM_SUPPORTED_VERSION|MINIMUM_SUPPORTED_MCP_VERSION|compatibility floor|API minimum|supportedVersionRange/i.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Derives the three stale-version matchers from the current minimum-supported floor. Keeping the shapes in
// one place (visible `vX.Y`, the `X.Y.x` range, and the bare `X.Y.Z` floor allowed only in an explicit
// minimum-supported statement) means the deterministic scan tracks the floor instead of a frozen literal.
export function buildStaleVersionMatchers(floorVersion: string): StaleVersionMatchers {
  if (!/^\d+\.\d+\.\d+$/.test(floorVersion)) {
    throw new Error(`Expected a semver minimum-supported floor like 0.5.0, got "${floorVersion}".`);
  }
  const [major, minor, patch] = floorVersion.split(".");
  const minorLabel = `${major}.${minor}`;
  const minorPattern = escapeRegExp(minorLabel);
  const patchPattern = escapeRegExp(patch!);
  const floorPattern = escapeRegExp(floorVersion);
  return {
    floorVersion,
    minorLabel,
    visibleVersion: new RegExp(`\\bv${minorPattern}(?:\\.${patchPattern})?\\b`),
    versionRange: new RegExp(`\\b${minorPattern}\\.x\\b`),
    floor: new RegExp(`\\b${floorPattern}\\b`),
  };
}

export function readKnownLatestVersion(path: string): string {
  const text = readFileSync(path, "utf8");
  const match = /MCP_PACKAGE_KNOWN_LATEST_VERSION\s*=\s*"([^"]+)"/.exec(text);
  if (!match) throw new Error("Could not find MCP_PACKAGE_KNOWN_LATEST_VERSION.");
  return match[1]!;
}

export function writeKnownLatestVersion(path: string, newVersion: string): void {
  const text = readFileSync(path, "utf8");
  const pattern = /MCP_PACKAGE_KNOWN_LATEST_VERSION\s*=\s*"([^"]+)"/;
  if (!pattern.test(text)) throw new Error("Could not find MCP_PACKAGE_KNOWN_LATEST_VERSION.");
  const updated = text.replace(pattern, `MCP_PACKAGE_KNOWN_LATEST_VERSION = "${newVersion}"`);
  writeFileSync(path, updated);
}

export function readMinimumSupportedVersion(path: string): string {
  const text = readFileSync(path, "utf8");
  const match = /MCP_MINIMUM_SUPPORTED_VERSION\s*=\s*"([^"]+)"/.exec(text);
  if (!match) throw new Error("Could not find MCP_MINIMUM_SUPPORTED_VERSION.");
  return match[1]!;
}

export function fetchLatestVersion(): Promise<string> {
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
