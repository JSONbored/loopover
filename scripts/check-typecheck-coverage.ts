#!/usr/bin/env node
// `npm run typecheck` must actually typecheck everything that can be typechecked (#9860).
//
// THE INCIDENT. #9815 turned main red because `ChatActionDispatchResult` was closed into a union and a
// miner-UI mock stopped satisfying it. The change was validated locally with `npm run typecheck`, which
// passed -- because `ui:typecheck` was in `test:ci` but NOT in the root `typecheck` chain. A contributor
// running the obvious command got a green result on a tree that does not compile.
//
// That is the worst shape a check can have: not missing, but SILENTLY PARTIAL. A missing check is noticed
// the first time something breaks; a partial one is trusted precisely because it passes.
//
// WHAT THIS COMPUTES. Every workspace that declares its own `typecheck` script, and whether the root
// `typecheck` script reaches it -- following `npm run <script>` references transitively, so a workspace
// covered through an intermediate script (`ui:typecheck` -> `npm --workspace @loopover/ui run typecheck`)
// counts as covered. Anything declaring a typecheck nobody runs is reported.
//
// This is #9853's bar applied to one more hand-maintained list: compute the fact rather than remember it.
// The failure that motivated the issue was not "someone forgot to add it" -- it was that nothing could tell
// them they had forgotten.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

export type TypecheckGap = { workspace: string; script: string };

/** Every `npm run <name>` this script body invokes (the root package's own scripts). */
function referencedRootScripts(body: string): string[] {
  // `npm run x`, `npm run x --silent`, `npm --silent run x` -- all forms used in this package.json.
  return [...body.matchAll(/npm\s+(?:--\S+\s+)*run\s+([\w:.-]+)/g)].map((match) => match[1]).filter((name): name is string => Boolean(name));
}

/** Every workspace whose OWN `typecheck` this script body invokes directly. */
function referencedWorkspaces(body: string): string[] {
  // `npm --workspace @scope/name run typecheck` and `npm run typecheck --workspace @scope/name`.
  const names = [
    ...body.matchAll(/npm\s+--workspace[= ]\s*(\S+)\s+run\s+([\w:.-]+)/g),
    ...body.matchAll(/npm\s+run\s+([\w:.-]+)\s+--workspace[= ]\s*(\S+)/g),
  ];
  const out: string[] = [];
  for (const match of names) {
    // The two patterns capture (workspace, script) and (script, workspace) respectively; the workspace is
    // whichever capture looks like a package name.
    const [a, b] = [match[1], match[2]];
    const workspace = a?.startsWith("@") || a?.includes("/") ? a : b;
    const script = workspace === a ? b : a;
    if (workspace && script === "typecheck") out.push(workspace);
  }
  return out;
}

/**
 * PURE: workspaces that declare a `typecheck` script the root `typecheck` never reaches.
 *
 * `scripts` is the root package's script map; `workspacesWithTypecheck` is every workspace package name that
 * declares one. Reachability follows `npm run` references transitively from `entry`, because a workspace is
 * covered whether it is invoked directly or through an intermediate script.
 */
export function findTypecheckGaps(
  scripts: Readonly<Record<string, string>>,
  workspacesWithTypecheck: readonly string[],
  entry = "typecheck",
): TypecheckGap[] {
  const covered = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const body = scripts[name];
    if (body === undefined) continue;
    for (const workspace of referencedWorkspaces(body)) covered.add(workspace);
    // A `tsc -p packages/<x>/tsconfig.json` counts too: the root chain typechecks that project directly
    // without going through the workspace's own script.
    for (const match of body.matchAll(/-p\s+((?:packages|apps)\/[\w.-]+)\//g)) {
      const dir = match[1];
      if (dir) covered.add(dir);
    }
    queue.push(...referencedRootScripts(body));
  }
  return workspacesWithTypecheck
    .filter((workspace) => !covered.has(workspace) && !covered.has(workspace.replace(/^@[\w-]+\//, "")))
    .map((workspace) => ({ workspace, script: "typecheck" }));
}

/** Workspace package names (and their directories) that declare their own `typecheck` script. */
export function workspacesDeclaringTypecheck(root: string): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = [];
  for (const group of ["apps", "packages"]) {
    let dirs: string[];
    try {
      dirs = readdirSync(join(root, group), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      try {
        const manifest = JSON.parse(readFileSync(join(root, group, dir, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string> };
        if (manifest.name && manifest.scripts?.typecheck) out.push({ name: manifest.name, dir: `${group}/${dir}` });
      } catch {
        // not a workspace package
      }
    }
  }
  return out;
}

function main(): void {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const declared = workspacesDeclaringTypecheck(root);
  const gaps = findTypecheckGaps(rootManifest.scripts ?? {}, declared.map((entry) => entry.name));

  if (gaps.length > 0) {
    console.error("`npm run typecheck` does not reach every workspace that declares one:\n");
    for (const gap of gaps) console.error(`  ${gap.workspace}  (declares "${gap.script}", never invoked)`);
    console.error(
      "\n  A typecheck that passes while part of the tree does not compile is worse than no typecheck: it is\n" +
        "  trusted BECAUSE it passes. #9815 turned main red exactly this way -- the change was validated with\n" +
        "  `npm run typecheck`, which did not cover apps/**.\n\n" +
        "  Fix: chain the workspace into the root `typecheck` script (directly, or through one it already\n" +
        "  calls), so the obvious command means what a contributor assumes it means.",
    );
    process.exit(1);
  }
  console.log(`typecheck-coverage: OK — all ${declared.length} workspace typecheck script(s) are reachable from \`npm run typecheck\`.`);
}

if (process.argv[1]?.endsWith("check-typecheck-coverage.ts")) main();
