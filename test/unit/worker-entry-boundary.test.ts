import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = join(root, "src");

const WORKER_ENTRY = join(srcRoot, "index.ts");
const MCP_BIN = join(root, "packages/gittensory-mcp/bin/loopover-mcp.js");

const FORBIDDEN_PATH = /(?:^|\/)visual-agent\//;
const FORBIDDEN_IDENTIFIERS = /\b(?:pixelmatch|pngjs|visual-diff|gifenc|sharp)\b/;

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = dirname(fromFile);
  const candidates = [
    join(base, specifier),
    join(base, `${specifier}.ts`),
    join(base, `${specifier}.tsx`),
    join(base, specifier, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function parseImportSpecifiers(filePath: string): string[] {
  const content = readFileSync(filePath, "utf8");
  const specifiers = new Set<string>();
  for (const match of content.matchAll(/(?:import|export)\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/g)) {
    specifiers.add(match[1]!);
  }
  for (const match of content.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]!);
  }
  return [...specifiers];
}

function collectReachableSources(entryFile: string): string[] {
  const queue = [entryFile];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of parseImportSpecifiers(file)) {
      const resolved = resolveLocalImport(file, specifier);
      if (resolved && resolved.startsWith(srcRoot) && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return [...seen].sort();
}

function relativeToRoot(path: string): string {
  return path.replace(`${root}/`, "");
}

describe("worker entry boundary", () => {
  it("does not import visual-agent modules from the Worker bundle entry", () => {
    const reachable = collectReachableSources(WORKER_ENTRY).map(relativeToRoot);
    const forbidden = reachable.filter((path) => FORBIDDEN_PATH.test(path));
    expect(forbidden, `worker entry must not reach agent-only modules: ${forbidden.join(", ")}`).toEqual([]);
  });

  it("does not reference pixelmatch, pngjs, visual-diff, gifenc, or sharp in worker-reachable source", () => {
    const hits = collectReachableSources(WORKER_ENTRY)
      .map((file) => {
        const content = readFileSync(file, "utf8");
        return FORBIDDEN_IDENTIFIERS.test(content) ? relativeToRoot(file) : null;
      })
      .filter((entry): entry is string => entry !== null);
    expect(hits, `worker-reachable files must not mention Node-only visual diff/GIF/image deps: ${hits.join(", ")}`).toEqual([]);
  });

  it("does not reference visual diff or GIF modules in the published MCP bin bundle", () => {
    const content = readFileSync(MCP_BIN, "utf8");
    expect(content).not.toMatch(FORBIDDEN_IDENTIFIERS);
    expect(content).not.toMatch(/visual-agent/);
  });
});
