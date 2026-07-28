// The TypeScript lock (#9527).
//
// Hand-written .mjs/.js/.cjs files are untyped surfaces the compiler cannot protect, and they
// accumulate the same way hand-copied schemas do -- 37 of them existed when this landed, including
// load-bearing generators that run inside test:ci. After the migration, this gate is what makes the
// state permanent: any tracked JavaScript (or hand-written .d.ts) outside the small, reasoned
// allowlist below fails CI.
//
// Two properties keep the allowlist itself from rotting:
//  1. Every entry carries a reason, in this file, next to the path.
//  2. An entry whose path no longer exists FAILS the check. A watched path that silently stops
//     existing is how metagraphed's MCP version-sync workflow rotted for months -- the guard is the
//     lesson.
//
// Run as `npm run validate:no-hand-written-js` (wired into test:ci). `git ls-files` is the source
// of truth, so untracked local files never fail and gitignored build output is never scanned.
import { execFileSync } from "node:child_process";

type AllowlistEntry = {
  /** Exact tracked path, or a directory prefix ending in "/". */
  path: string;
  reason: string;
};

export const ALLOWLIST: AllowlistEntry[] = [
  {
    path: "test/fixtures/",
    reason:
      "Subprocess test doubles (scorer/store/allocator children) spawned as real child processes by plain `node` to reproduce exact runtime behavior, several deliberately malformed. Porting them buys no type safety and couples every spawn site to a TS loader.",
  },
  {
    path: "packages/loopover-mcp/scripts/gittensor-score-preview.mjs",
    reason:
      "Shipped in the published npm tarball (see scripts/mcp-package-allowlist.ts) and executed by end users' own plain `node`, which cannot be assumed to run TypeScript.",
  },
  {
    path: "apps/loopover-ui/public/sw.js",
    reason: "Service worker served byte-for-byte to browsers from public/; there is no build step between this file and the client.",
  },
  {
    path: "scripts/rees-coverage-chdir.cjs",
    reason:
      "Preloaded via node --require, which only loads CommonJS. Its 3 lines chdir the spawned test child so c8's lcov paths remap for Codecov (#6250).",
  },
  {
    path: "src/env.d.ts",
    reason: "Ambient declarations for the Worker env -- ambient typing is what .d.ts is for; there is no runtime module to port.",
  },
  {
    path: "control-plane/src/env.d.ts",
    reason: "Ambient declarations, same as src/env.d.ts.",
  },
  {
    path: "packages/discovery-index/src/env.d.ts",
    reason: "Ambient declarations, same as src/env.d.ts.",
  },
  {
    path: "src/selfhost/stubs/gifenc.d.ts",
    reason: "Hand-written module declaration for the untyped gifenc dependency -- an ambient stub, not a shadowed implementation.",
  },
];

/** Generated .d.ts is exempt by name, not allowlisted: `cf-typegen:check` already proves these
 *  match their generator, which is a stronger guarantee than a reason string. */
const GENERATED_BASENAMES = new Set(["worker-configuration.d.ts"]);

export function isAllowed(path: string): boolean {
  return ALLOWLIST.some((entry) => (entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path));
}

export function isGenerated(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return GENERATED_BASENAMES.has(basename);
}

export function classify(trackedFiles: readonly string[]): { violations: string[]; staleAllowlist: string[] } {
  const targets = trackedFiles.filter(
    (path) => (path.endsWith(".mjs") || path.endsWith(".cjs") || path.endsWith(".js") || path.endsWith(".d.ts")) && !isGenerated(path),
  );
  const violations = targets.filter((path) => !isAllowed(path));
  const tracked = new Set(trackedFiles);
  const staleAllowlist = ALLOWLIST.filter((entry) =>
    entry.path.endsWith("/") ? ![...tracked].some((path) => path.startsWith(entry.path)) : !tracked.has(entry.path),
  ).map((entry) => entry.path);
  return { violations, staleAllowlist };
}

function main(): void {
  const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const { violations, staleAllowlist } = classify(trackedFiles);

  if (violations.length > 0) {
    console.error("Hand-written JavaScript (or hand-written .d.ts) is not allowed in this repo (#9527).");
    console.error("Port these to .ts, or -- only with a real reason -- add an entry to ALLOWLIST in scripts/validate-no-hand-written-js.ts:");
    for (const path of violations) console.error(`  ${path}`);
  }
  if (staleAllowlist.length > 0) {
    console.error("These ALLOWLIST entries match nothing tracked -- delete them (a silently-dead watched path is how checks rot):");
    for (const path of staleAllowlist) console.error(`  ${path}`);
  }
  if (violations.length > 0 || staleAllowlist.length > 0) process.exit(1);
  console.log(`no-hand-written-js: clean (${ALLOWLIST.length} allowlisted entries, all present).`);
}

// Import-safe for tests; only executes as a CLI entry.
if (process.argv[1]?.endsWith("validate-no-hand-written-js.ts")) main();
