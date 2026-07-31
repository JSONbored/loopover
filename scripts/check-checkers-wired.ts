// Every `scripts/check-*.ts` must actually RUN somewhere (#9860, item 3).
//
// The failure this exists to prevent: a checker lands, is correct, is reviewed, and is never wired into
// anything. It then guards nothing while looking exactly like a guard -- and the class it was written to
// catch keeps shipping. That is strictly worse than not having written it, because its presence in the tree
// is read as coverage.
//
// It is the same shape as the three incidents behind #9860: a hand-maintained list (here, `test:ci`'s ~50
// command chain) that nobody re-derives. So this does not hold a list of which checkers are wired. It
// COMPUTES where each one runs, from the three places a checker can legitimately live:
//
//   1. Reachable from `test:ci` -- transitively, since `test:ci` calls npm scripts that call npm scripts.
//   2. Referenced by a GitHub workflow -- release cadence and ops probes belong there, not in the local gate.
//   3. Imported by another script -- a shared module that happens to match `check-*.ts` is not an entry point.
//
// A checker in none of the three is dead, and this fails with the specific fix. ALLOWED_UNWIRED exists for
// the genuine exception, and each entry must carry a reason -- but reaching for it should feel like a
// concession, because "add it to the list too" is exactly the fix #9860 rejects.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `npm run <name>`, capturing a trailing `--workspace` so a workspace-scoped call is not read as a root one. */
const NPM_RUN_REFERENCE = /npm run ([\w:.-]+)((?:\s+--workspace[= ]\S+)?)/g;

const SCRIPTS_DIR = "scripts";
const WORKFLOWS_DIR = ".github/workflows";

/**
 * Checkers that legitimately run nowhere in this repo, with the reason. Deliberately tiny: a checker whose
 * home is a workflow or `test:ci` is DETECTED, never listed, so this holds only the true oddities.
 */
const ALLOWED_UNWIRED: Record<string, string> = {
  "check-changelog.ts": "release-time only: run against a release-please branch, where the changelog it validates exists. Nothing in the local gate produces one.",
  "check-roadmap-issue-drift.ts": "operator-invoked: reads live GitHub issues, so it needs a token and a network the local gate deliberately does not assume.",
};

/**
 * npm scripts referenced by `root` that DO NOT EXIST (#9860).
 *
 * Found the hard way: `test:ci` called `npm run publishable-deps:check`, no such script was ever defined, so
 * the documented one-command local gate died with "Missing script" -- and the checker behind it had never
 * run. A chain of ~50 hand-kept commands has no other way of noticing that one of them is a typo or a
 * rename, which is precisely the hand-maintained-list class this file exists to close.
 *
 * `--workspace` invocations are excluded: those resolve against the workspace's own package.json.
 */
export function danglingScriptReferences(scripts: Record<string, string>, root: string): string[] {
  const body = scripts[root];
  if (body === undefined) return [];
  const missing = new Set<string>();
  for (const match of body.matchAll(NPM_RUN_REFERENCE)) {
    if (match[2]) continue;
    const name = match[1]!;
    if (!(name in scripts)) missing.add(name);
  }
  return [...missing].sort();
}

/** Every `check-*.ts` entry point under scripts/. */
export function listCheckerScripts(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry.startsWith("check-") && entry.endsWith(".ts")).sort();
}

/**
 * The npm scripts transitively reachable from `root`, following `npm run <name>` references.
 *
 * Transitive because `test:ci` does not invoke every checker directly -- several sit behind an aggregate
 * script. Treating only direct mentions as wired would report a correctly-wired checker as dead, and a
 * checker that cries wolf gets muted, which would leave the repo worse off than before.
 */
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
      // `npm run build --workspace X` targets the WORKSPACE's script, not a root one -- following it as a
      // root reference would both miss the real target and report a nonexistent root "build".
      if (match[2]) continue;
      const next = match[1]!;
      if (!seen.has(next)) queue.push(next);
    }
    // npm lifecycle hooks run automatically around their base script, so a checker wired as `pretest` is
    // wired -- no `npm run` mentions it anywhere. Missing this reported correctly-wired checkers as dead,
    // and a checker that cries wolf gets muted.
    for (const hook of [`pre${name}`, `post${name}`]) {
      if (scripts[hook] !== undefined && !seen.has(hook)) queue.push(hook);
    }
  }
  return seen;
}

/** Which of `scripts` (by npm-script name) invoke this checker file. */
export function npmScriptsInvoking(scripts: Record<string, string>, file: string): string[] {
  return Object.entries(scripts)
    .filter(([, body]) => body.includes(`${SCRIPTS_DIR}/${file}`))
    .map(([name]) => name)
    .sort();
}

export type CheckerHome =
  | { kind: "test-ci"; via: string }
  | { kind: "workflow"; via: string }
  | { kind: "imported"; via: string }
  | { kind: "allowed"; via: string }
  | { kind: "none" };

/** Drop line (`//`) and block comments so a prose mention of a checker is not treated as an import (#10048). */
function stripScriptComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * True when `source` has a real import, re-export, or dynamic-import of `./base` (optional .ts or .js).
 * Specifier must sit in statement position — a bare substring or comment mention does not count (#10048).
 */
function sourceImportsChecker(source: string, base: string): boolean {
  const code = stripScriptComments(source);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const specifier = `\\./${escaped}(?:\\.(?:ts|js))?`;
  return new RegExp(`(?:(?:import|export)\\s[^;]*?\\sfrom\\s*|import\\s*\\(\\s*)['"]${specifier}['"]`).test(code);
}

/** Where a checker actually runs, or `none`. Pure, so every branch is testable without a filesystem. */
export function resolveCheckerHome(input: {
  file: string;
  scripts: Record<string, string>;
  reachableFromTestCi: ReadonlySet<string>;
  workflowText: string;
  otherScriptSources: readonly string[];
  allowed?: Record<string, string>;
}): CheckerHome {
  const invokers = npmScriptsInvoking(input.scripts, input.file);
  const wired = invokers.find((name) => input.reachableFromTestCi.has(name));
  if (wired !== undefined) return { kind: "test-ci", via: `npm run ${wired}` };

  // A workflow may call the npm script OR the file directly (`tsx scripts/check-foo.ts`); both count.
  const workflowRef = invokers.find((name) => input.workflowText.includes(name)) ?? (input.workflowText.includes(input.file) ? input.file : undefined);
  if (workflowRef !== undefined) return { kind: "workflow", via: workflowRef };

  // Imported by a sibling script => a shared module, not an entry point. Require an actual import /
  // re-export / dynamic-import statement after stripping comments — a prose mention must not count (#10048).
  const base = input.file.replace(/\.ts$/, "");
  if (input.otherScriptSources.some((source) => sourceImportsChecker(source, base))) {
    return { kind: "imported", via: base };
  }

  const reason = (input.allowed ?? ALLOWED_UNWIRED)[input.file];
  if (reason !== undefined) return { kind: "allowed", via: reason };
  return { kind: "none" };
}

function main(): void {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const entries = readdirSync(SCRIPTS_DIR);
  const checkers = listCheckerScripts(entries);
  const reachable = reachableNpmScripts(pkg.scripts, "test:ci");

  const workflowText = readdirSync(WORKFLOWS_DIR)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => readFileSync(join(WORKFLOWS_DIR, entry), "utf8"))
    .join("\n");

  const dangling = danglingScriptReferences(pkg.scripts, "test:ci");
  if (dangling.length > 0) {
    console.error(`check-checkers-wired: "test:ci" references ${dangling.length} npm script(s) that do not exist, so the local gate cannot run to completion:\n`);
    for (const name of dangling) console.error(`  npm run ${name}`);
    console.error("\nDefine the script, or remove the step from test:ci.");
    process.exit(1);
  }

  const dead: string[] = [];
  for (const file of checkers) {
    // Every OTHER script, so a file cannot count as its own importer.
    const otherScriptSources = entries
      .filter((entry) => entry.endsWith(".ts") && entry !== file)
      .map((entry) => readFileSync(join(SCRIPTS_DIR, entry), "utf8"));
    const home = resolveCheckerHome({ file, scripts: pkg.scripts, reachableFromTestCi: reachable, workflowText, otherScriptSources });
    if (home.kind === "none") dead.push(file);
  }

  if (dead.length > 0) {
    console.error(`check-checkers-wired: ${dead.length} checker(s) run NOWHERE — they guard nothing while looking like a guard (#9860):\n`);
    for (const file of dead) console.error(`  ${SCRIPTS_DIR}/${file}`);
    console.error(
      [
        "",
        "Fix by giving each one a real home:",
        `  • local gate  — add an npm script and chain it into "test:ci"`,
        `  • scheduled   — reference it from a workflow under ${WORKFLOWS_DIR}/`,
        "  • shared code — if it is not an entry point, import it from the script that uses it",
        "",
        "Only as a last resort, add it to ALLOWED_UNWIRED in this file WITH a reason.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`check-checkers-wired: all ${checkers.length} scripts/check-*.ts entry points run somewhere.`);
}

if (process.argv[1]?.endsWith("check-checkers-wired.ts")) main();
