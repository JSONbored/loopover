// A check in `test:ci` is not a gate unless a workflow runs it too (#10269).
//
// `npm run test:ci` is the documented local gate; `.github/workflows/**` is what actually blocks a merge.
// They are two independently hand-maintained lists, and they drifted: 22 of the 42 checks reachable from
// `test:ci` ran in NO workflow at all. On a repo whose gate auto-merges on green CI, such a check is a
// convention, not a gate -- and it reads as coverage, which is worse than not having it.
//
// This is check-checkers-wired.ts's sibling, on the other axis. That one asks "does this scripts/check-*.ts
// run ANYWHERE (test:ci included)?" and so is satisfied by the local gate alone. This one asks the question
// that matters for merge safety: "does CI actually run it?"
//
// It is deliberately COMPUTED, never a list of what is wired -- the same reasoning as #9860. A hand-kept
// roster of "checks CI runs" would drift from ci.yml exactly the way ci.yml drifted from test:ci.
//
// ALLOWED_LOCAL_ONLY is the escape hatch and each entry must carry a reason. Reaching for it should feel
// like a concession: "add it to the list too" is the fix this file exists to reject.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = ".github/workflows";
const ROOT_SCRIPT = "test:ci";

/** `npm run <name>`, capturing a trailing `--workspace` so a workspace-scoped call is not read as a root one. */
const NPM_RUN_REFERENCE = /npm run ([\w:.-]+)((?:\s+--workspace[= ]\S+)?)/g;

/**
 * Which npm-script names count as a "check" for this rule.
 *
 * Naming-based on purpose: it is the convention this repo already follows for every drift/wiring guard, and
 * it means a newly added check is covered the moment it is named like its siblings, with nothing to
 * register. Build, test and coverage steps are out of scope -- CI runs those through its own jobs.
 */
export function isDriftCheckScript(name: string): boolean {
  // `-audit` as well as `:audit`: this repo names both ways (`ui:version-audit`,
  // `test:miner-deployment-docs-audit`), and a `:audit$`-only pattern silently matched NEITHER -- a
  // scoping bug that would have quietly excluded them from the rule while looking like it covered them.
  return /:check$|drift-check$|[:-]audit$/.test(name);
}

/** Checks that legitimately run only in the local gate, with the reason. Deliberately empty. */
const ALLOWED_LOCAL_ONLY: Record<string, string> = {};

/** The npm scripts transitively reachable from `root`, following `npm run <name>` references. */
export function reachableNpmScripts(scripts: Record<string, string>, root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = scripts[name];
    if (body === undefined) continue;
    for (const match of body.matchAll(NPM_RUN_REFERENCE)) {
      // `npm run build --workspace X` targets the WORKSPACE's script, not a root one.
      if (match[2]) continue;
      if (!seen.has(match[1]!)) queue.push(match[1]!);
    }
  }
  return seen;
}

/** Every drift check the local gate runs. */
export function driftChecksInLocalGate(scripts: Record<string, string>, root = ROOT_SCRIPT): string[] {
  return [...reachableNpmScripts(scripts, root)].filter((name) => name !== root && isDriftCheckScript(name)).sort();
}

/**
 * PURE. Checks the local gate runs that no workflow does.
 *
 * Matched on `npm run <name>` rather than on the script file, because that is how a workflow invokes one and
 * it is the same string the local gate uses -- so a rename breaks both sides together instead of silently
 * satisfying this while running nothing. The word-boundary guard stops `foo:check` being considered wired by
 * a workflow that only mentions `foo:check:extra`.
 */
export function checksMissingFromWorkflows(
  checks: readonly string[],
  workflowText: string,
  allowed: Record<string, string> = ALLOWED_LOCAL_ONLY,
): string[] {
  return checks.filter((name) => {
    if (name in allowed) return false;
    return !new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:.-])`).test(workflowText);
  });
}

function main(): void {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const workflowText = readdirSync(WORKFLOWS_DIR)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => readFileSync(join(WORKFLOWS_DIR, entry), "utf8"))
    .join("\n");

  const checks = driftChecksInLocalGate(pkg.scripts);
  const missing = checksMissingFromWorkflows(checks, workflowText);

  if (missing.length > 0) {
    console.error(`check-ci-drift-checks-wired: ${missing.length} of ${checks.length} check(s) run in the local gate but in NO workflow (#10269):\n`);
    for (const name of missing) console.error(`  npm run ${name}`);
    console.error(
      [
        "",
        "A check CI never runs does not gate a merge -- it only looks like it does.",
        "Fix by adding it to the appropriate place in .github/workflows/ci.yml:",
        '  • most checks   — the "Drift checks (unconditional)" block in validate-code',
        "  • needs git history (tags, or a diff against the base) — the drift-checks-history job,",
        "    since validate-code's checkout is shallow and several checks pass VACUOUSLY there",
        "",
        "Only as a last resort, add it to ALLOWED_LOCAL_ONLY in this file WITH a reason.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`check-ci-drift-checks-wired: all ${checks.length} local-gate drift check(s) also run in a workflow.`);
}

if (process.argv[1]?.endsWith("check-ci-drift-checks-wired.ts")) main();
