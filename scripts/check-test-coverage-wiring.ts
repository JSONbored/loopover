#!/usr/bin/env node
// `npm run test:ci` must actually RUN every workspace's declared `test` script (#10049).
//
// THE INCIDENT. `packages/loopover-ui-kit` ships `"test": "vitest run"` and a package-local vitest.config.ts
// whose own header states the acceptance signal is "this suite runs and passes". Nothing invokes it: root
// `ui:test` builds ui-kit but only ever runs @loopover/ui and @loopover/ui-miner's tests, `test:ci` reaches
// ui-kit only through build/pack/lint/typecheck steps, and ci.yml has no ui-kit test step. The suite's 12
// files (60+ tests) have sat there, never executed, since #7437/#7495 added them.
//
// That is the exact shape #9860 named: not a MISSING check, but a SILENTLY PARTIAL one -- trusted precisely
// because everything around it (build, pack, lint, typecheck) is green. #9860's own fix for this class was
// `scripts/check-typecheck-coverage.ts`, which proved `npm run typecheck` reaches every workspace that
// declares one. This is that same computation for `test`.
//
// WHAT THIS COMPUTES. Every workspace under apps/*/packages/* that declares its own `test` script, and
// whether the root `test:ci` chain reaches it -- following `npm run <script>` references transitively, so a
// workspace covered through an intermediate script (`ui:test` -> `npm --workspace @loopover/ui-kit run
// test`) counts as covered. Anything declaring a `test` nobody runs is reported.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

export type TestWiringGap = { workspace: string; script: string };

export type WorkspaceWithTest = { name: string; dir: string };

/** Every `npm run <name>` this script body invokes (the root package's own scripts). */
function referencedRootScripts(body: string): string[] {
  // `npm run x`, `npm run x --silent`, `npm --silent run x` -- all forms used in this package.json.
  return [...body.matchAll(/npm\s+(?:--\S+\s+)*run\s+([\w:.-]+)/g)].map((match) => match[1]).filter((name): name is string => Boolean(name));
}

/** Every workspace whose OWN `test` this script body invokes directly. */
function referencedWorkspaces(body: string): string[] {
  // `npm --workspace @scope/name run test` and `npm run test --workspace @scope/name`.
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
    if (workspace && script === "test") out.push(workspace);
  }
  return out;
}

/**
 * PURE: workspaces that declare a `test` script the root `test:ci` chain never reaches.
 *
 * `scripts` is the root package's script map; `workspacesWithTest` is every workspace that declares one
 * (package name + directory). Reachability follows `npm run` references transitively from `entry`, because
 * a workspace is covered whether its `test` is invoked directly or through an intermediate script.
 */
export function findTestWiringGaps(
  scripts: Readonly<Record<string, string>>,
  workspacesWithTest: readonly WorkspaceWithTest[],
  entry = "test:ci",
): TestWiringGap[] {
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
    queue.push(...referencedRootScripts(body));
  }
  return workspacesWithTest
    .filter(
      (workspace) =>
        !covered.has(workspace.name) &&
        !covered.has(workspace.name.replace(/^@[\w-]+\//, "")) &&
        !covered.has(workspace.dir),
    )
    .map((workspace) => ({ workspace: workspace.name, script: "test" }));
}

/** Workspace package names (and their directories) that declare their own `test` script. */
export function workspacesDeclaringTest(root: string): WorkspaceWithTest[] {
  const out: WorkspaceWithTest[] = [];
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
        if (manifest.name && manifest.scripts?.test) out.push({ name: manifest.name, dir: `${group}/${dir}` });
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
  const declared = workspacesDeclaringTest(root);
  const gaps = findTestWiringGaps(rootManifest.scripts ?? {}, declared);

  if (gaps.length > 0) {
    console.error("`npm run test:ci` does not reach every workspace that declares a `test` script:\n");
    for (const gap of gaps) console.error(`  ${gap.workspace}  (declares "${gap.script}", never invoked)`);
    console.error(
      "\n  A suite that exists, is written to pin real behaviour, and never runs is worse than no suite: it is\n" +
        "  trusted BECAUSE nothing around it is red. #10049 found exactly this for @loopover/ui-kit's 12-file\n" +
        "  vitest suite -- present since #7437/#7495, never executed.\n\n" +
        "  Fix: chain the workspace's `test` into the root `test:ci` script (directly, or through one it\n" +
        "  already calls, e.g. `ui:test`), so a declared test script always means a running test script.",
    );
    process.exit(1);
  }
  console.log(`test-wiring: OK — all ${declared.length} workspace test script(s) are reachable from \`npm run test:ci\`.`);
}

if (process.argv[1]?.endsWith("check-test-coverage-wiring.ts")) main();
