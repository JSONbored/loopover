import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = join(root, "src");

const WORKER_ENTRY = join(srcRoot, "index.ts");
const MCP_BIN = join(root, "packages/loopover-mcp/dist/bin/loopover-mcp.js");

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

  // Scans MODULE SPECIFIERS, not raw file text. What this guards is the Worker BUNDLE: a Node-only dep can
  // only get bundled by being imported (statically or dynamically), so parsing the same specifiers
  // collectReachableSources already walks catches every real inclusion path. Grepping whole-file content
  // instead produced a false positive the moment ordinary English prose contained one of these words --
  // #9230 added the user-facing string "route(s) crossed the visual-diff threshold" to
  // src/review/visual/visual-findings.ts (a file worker-reachable since #4120, importing none of these deps),
  // and the raw-content regex failed a green tree over a sentence. Bending correct user-facing copy to dodge
  // a test regex would have been the wrong repair; narrowing the check to what it actually means is the right
  // one.
  it("does not import pixelmatch, pngjs, visual-diff, gifenc, or sharp from worker-reachable source", () => {
    const hits = collectReachableSources(WORKER_ENTRY)
      .map((file) => {
        const offending = parseImportSpecifiers(file).filter((specifier) => FORBIDDEN_IDENTIFIERS.test(specifier));
        return offending.length > 0 ? `${relativeToRoot(file)} (${offending.join(", ")})` : null;
      })
      .filter((entry): entry is string => entry !== null);
    expect(hits, `worker-reachable files must not import Node-only visual diff/GIF/image deps: ${hits.join(", ")}`).toEqual([]);
  });

  // Proves the specifier-scoped check above is still DISCRIMINATING, not vacuously passing: the same regex
  // must still flag a real dependency import, and must still ignore the same word in prose. Without this, a
  // future edit that broke the matching entirely would look identical to a clean tree.
  it("the forbidden-identifier check still flags a real import specifier and still ignores prose", () => {
    expect(["sharp", "pixelmatch", "gifenc", "pngjs", "@foo/visual-diff"].every((specifier) => FORBIDDEN_IDENTIFIERS.test(specifier))).toBe(true);
    expect(["./capture", "../../types", "node:fs", "hono"].some((specifier) => FORBIDDEN_IDENTIFIERS.test(specifier))).toBe(false);
    // The exact #9230 prose that broke the old whole-file scan is not a module specifier, so it is correctly
    // invisible to a specifier-scoped check -- while the bare dep name it contains still is not.
    expect(parseImportSpecifiers(join(srcRoot, "review/visual/visual-findings.ts")).some((s) => FORBIDDEN_IDENTIFIERS.test(s))).toBe(false);
  });

  it("does not reference visual diff or GIF modules in the published MCP bin bundle", () => {
    const content = readFileSync(MCP_BIN, "utf8");
    expect(content).not.toMatch(FORBIDDEN_IDENTIFIERS);
    expect(content).not.toMatch(/visual-agent/);
  });
});
