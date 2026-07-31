#!/usr/bin/env node
// turbo's `//#typecheck` inputs must cover everything tsc actually reads (#9848).
//
// THE HAZARD, in turbo.json's own words: that inputs list is "a snapshot of test/'s real cross-package reach
// as of the audit that added it, not a structural guarantee -- a future test file importing from a NOT-yet-
// listed package/app would reopen the same silent-stale-cache gap." It then asks a human to "re-run the same
// grep ... before trusting this list again."
//
// Nobody re-runs a grep on request, and the list HAD already drifted when this check was written: `src/` and
// `test/` import from `packages/loopover-mcp/lib/**` and `packages/loopover-miner/scripts/**`, neither of
// which was hashed. Editing either could therefore leave a stale cache HIT on a typecheck that a real
// `tsc --noEmit` would fail -- the exact class of bug PR #5082 already burned this repo on once, and the
// reason the list exists at all.
//
// So: compute the reach instead of remembering it. This is the grep that comment asks for, run every CI.
//
// WHAT COUNTS AS COVERED. A path is fine if it is matched by an inputs glob, OR if it belongs to a workspace
// this task already `dependsOn` -- turbo hashes a dependency task's own inputs, so `@loopover/engine#build`
// covers the engine's sources without them being listed here. Anything else is unhashed and reported.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

/** A cross-boundary import found in src/ or test/, as `<group>/<workspace>/<first-segment>`. */
export type CrossBoundaryReach = { path: string; importedBy: string };

/** Strip `//` line comments and trailing commas so turbo.json (JSONC) parses. Deliberately not a full JSONC
 *  parser: this file is ours, its comment style is known, and a dependency for one read would be worse. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * PURE core: every cross-workspace path `src/`+`test/` reach that no glob and no dependency covers.
 *
 * `globs` are turbo `inputs` entries; `coveredWorkspaces` are the workspace directory names whose builds this
 * task depends on. Matching is prefix-based on the glob's literal head, which is all turbo's own globs use
 * here (`packages/x/lib/**`) -- a stricter matcher would reject valid entries and a looser one would let a
 * real gap through.
 */
export function findUnhashedReach(
  reach: readonly CrossBoundaryReach[],
  globs: readonly string[],
  coveredWorkspaces: ReadonlySet<string>,
): CrossBoundaryReach[] {
  const prefixes = globs.map((glob) => glob.replace(/\*\*.*$/, "").replace(/\/$/, ""));
  return reach.filter((entry) => {
    const workspace = entry.path.split("/").slice(0, 2).join("/");
    if (coveredWorkspaces.has(workspace)) return false;
    return !prefixes.some((prefix) => prefix.length > 0 && (entry.path === prefix || entry.path.startsWith(`${prefix}/`) || prefix.startsWith(entry.path)));
  });
}

function walk(dir: string, out: string[]): void {
  // Typed via the call's own return rather than `ReturnType<typeof readdirSync>`: that resolves to the
  // Buffer-named overload under this tsconfig, which the string form is not assignable to.
  let entries: ReadonlyArray<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a directory that does not exist here is not an error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
}

/** Every `packages/<x>/<seg>` or `apps/<x>/<seg>` a relative import from src/ or test/ reaches. */
export function collectCrossBoundaryReach(root: string): CrossBoundaryReach[] {
  const files: string[] = [];
  walk(join(root, "src"), files);
  walk(join(root, "test"), files);

  const reach = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Static `from "..."`, bare `import "..."`, and dynamic `import("...")` (incl. multi-line) — side-effect
    // and JSON imports are type-checked too. Mirror check-dead-source-files.ts's optional-paren form (#10046).
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"((?:\.\.\/)+[^"]+)"/g)) {
      const specifier = match[1];
      if (!specifier) continue;
      const segments = /(?:^|\/)(packages|apps)\/([^/]+)\/([^/"]+)/.exec(specifier);
      if (!segments) continue;
      const path = `${segments[1]}/${segments[2]}/${segments[3]}`;
      // Must exist on disk. The checker-testing files (check-import-specifiers-script.test.ts et al.) embed
      // import statements INSIDE FIXTURE STRINGS -- `"src/foo.ts": 'import ... from "../packages/engine/..."'`
      // -- and those name packages that were renamed away or never existed. A path tsc cannot resolve is not
      // part of its real surface, so requiring the directory to exist filters exactly those without needing
      // to parse TypeScript to tell code from a string literal.
      if (!existsSync(join(root, path))) continue;
      if (!reach.has(path)) reach.set(path, file);
    }
  }
  return [...reach].map(([path, importedBy]) => ({ path, importedBy })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Workspace dirs whose build this task depends on — turbo hashes their inputs transitively. */
export function coveredWorkspacesFromDependsOn(dependsOn: readonly string[], root: string): Set<string> {
  const covered = new Set<string>();
  for (const dependency of dependsOn) {
    const name = dependency.split("#")[0];
    if (!name) continue;
    for (const group of ["packages", "apps"]) {
      let dirs: string[];
      try {
        dirs = readdirSync(join(root, group), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const dir of dirs) {
        try {
          const manifest = JSON.parse(readFileSync(join(root, group, dir, "package.json"), "utf8")) as { name?: string };
          if (manifest.name === name) covered.add(`${group}/${dir}`);
        } catch {
          // not a workspace package
        }
      }
    }
  }
  return covered;
}

function main(): void {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const turbo = parseJsonc(readFileSync(join(root, "turbo.json"), "utf8")) as {
    tasks?: Record<string, { inputs?: string[]; dependsOn?: string[] }>;
  };
  const task = turbo.tasks?.["//#typecheck"];
  if (!task) {
    console.error('turbo-typecheck-inputs: turbo.json has no "//#typecheck" task — this check can no longer verify anything, so it fails rather than passing silently.');
    process.exit(1);
  }

  const unhashed = findUnhashedReach(
    collectCrossBoundaryReach(root),
    task.inputs ?? [],
    coveredWorkspacesFromDependsOn(task.dependsOn ?? [], root),
  );

  if (unhashed.length > 0) {
    console.error("turbo //#typecheck does not hash everything tsc reads:\n");
    for (const entry of unhashed) console.error(`  ${entry.path}  (e.g. imported by ${entry.importedBy})`);
    console.error(
      "\n  tsc's real surface is everything transitively imported from src/ + test/, wherever it lives. A path\n" +
        "  reached from there but absent from `inputs` (and not covered by a dependsOn build) is NOT hashed, so\n" +
        "  editing it can leave a stale cache HIT on a typecheck a real `tsc --noEmit` would fail — the #5082\n" +
        "  class of bug this inputs list exists to prevent.\n\n" +
        '  Fix: add the path (e.g. "packages/x/lib/**") to //#typecheck\'s `inputs` in turbo.json.',
    );
    process.exit(1);
  }
  console.log("turbo-typecheck-inputs: OK — every cross-workspace path src/+test/ reach is hashed.");
}

if (process.argv[1]?.endsWith("check-turbo-typecheck-inputs.ts")) main();
