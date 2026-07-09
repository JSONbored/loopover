// Lint-guarded edit wrapper for coding-agent drivers (#4276). This repo has no repo-wide ESLint (or other
// linter) at the src/packages/* level -- the only ESLint config is apps/gittensory-ui/eslint.config.js,
// wired up solely through `ui:lint`. The gate everything else runs is `typecheck` (`tsc --noEmit`) plus each
// package/* under `packages/*` having its OWN build-time check: `gittensory-engine` runs its own `tsc -p
// tsconfig.json`; `gittensory-miner`/`gittensory-mcp` ship plain JS with `node --check` per shipped `.js`
// file (their non-`.js` files, like hand-written `.d.ts` declarations, are covered by the root typecheck
// instead, same as `src/`). "Lint-guarded" therefore means: after a coding-agent driver edits files, run the
// EXISTING check appropriate to each changed file's package -- never introduce a new linter.
//
// Implementations here MAY perform real IO (spawn `tsc`/`node`/`npm`), same allowance as `CodingAgentDriver`
// itself (coding-agent-driver.ts) -- the spawn function is injected (mirrors `SpawnFn` in
// `src/selfhost/ai.ts`), so this module stays synchronous-IO-free in tests.
import type { CodingAgentDriverResult } from "./coding-agent-driver.js";

/** Which existing check governs a changed file. `root` covers `src/**` and any non-`.js` file under
 *  `packages/gittensory-miner`/`packages/gittensory-mcp` (e.g. a hand-written `.d.ts`), since those are
 *  type-checked by the root `tsc --noEmit`, not `node --check`. */
export type LintGuardPackage = "ui" | "engine" | "miner-js" | "mcp-js" | "root";

const MINER_JS_EXTENSION = /\.(js|mjs|cjs)$/;

/** Classify a changed file path (POSIX or Windows separators) into the package whose existing check governs
 *  it. Pure path matching -- no filesystem access. */
export function classifyLintGuardPackage(path: string): LintGuardPackage {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("apps/gittensory-ui/")) return "ui";
  if (normalized.startsWith("packages/gittensory-engine/")) return "engine";
  if (normalized.startsWith("packages/gittensory-miner/") && MINER_JS_EXTENSION.test(normalized)) return "miner-js";
  if (normalized.startsWith("packages/gittensory-mcp/") && MINER_JS_EXTENSION.test(normalized)) return "mcp-js";
  return "root";
}

export type LintGuardSpawnResult = { ok: boolean; output: string };

/** Injected process runner -- real IO lives here, not in `guardChangedFiles`, so tests never spawn a real
 *  subprocess. `ok` is derived from the exit code by the caller of this function, not by this type. */
export type LintGuardSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string },
) => Promise<{ code: number | null; output: string }>;

export type LintGuardCheckResult = {
  package: LintGuardPackage;
  file: string;
  command: string;
  ok: boolean;
  output: string;
};

/** Structured result -- never a thrown exception -- so a caller (the self-review loop, #2333) can
 *  distinguish "the edit doesn't typecheck" (a `checks` entry with `ok: false`) from "the coding agent
 *  itself failed" (a separate concern entirely, see {@link guardCodingAgentDriverResult}). */
export type LintGuardResult = {
  ok: boolean;
  checks: readonly LintGuardCheckResult[];
};

export type LintGuardOptions = {
  spawn: LintGuardSpawnFn;
  /** Repo root the checks run from. Default: `process.cwd()`. */
  cwd?: string | undefined;
};

const PACKAGE_COMMAND: Readonly<Record<Exclude<LintGuardPackage, "miner-js" | "mcp-js">, readonly string[]>> = Object.freeze({
  root: Object.freeze(["npm", "run", "typecheck"]),
  engine: Object.freeze(["npm", "run", "build", "--workspace", "@jsonbored/gittensory-engine"]),
  ui: Object.freeze(["npm", "run", "ui:typecheck"]),
});

async function runPackageCheck(
  pkg: LintGuardPackage,
  files: readonly string[],
  spawn: LintGuardSpawnFn,
  cwd: string,
): Promise<LintGuardCheckResult[]> {
  if (pkg === "miner-js" || pkg === "mcp-js") {
    // node --check is inherently per-file, unlike the whole-package tsc/ui:lint commands below.
    const results: LintGuardCheckResult[] = [];
    for (const file of files) {
      const { code, output } = await spawn("node", ["--check", file], { cwd });
      results.push({ package: pkg, file, command: `node --check ${file}`, ok: code === 0, output });
    }
    return results;
  }
  const command = PACKAGE_COMMAND[pkg];
  const { code, output } = await spawn(command[0]!, command.slice(1), { cwd });
  return [{ package: pkg, file: files.join(", "), command: command.join(" "), ok: code === 0, output }];
}

/**
 * Run the existing check for every package a changed file belongs to. One check per package group, not one
 * per file (except `node --check`, which is inherently per-file) -- `tsc`/`ui:typecheck` validate a whole
 * package at once, so re-running them per file would be redundant work, not extra coverage.
 */
export async function guardChangedFiles(
  changedFiles: readonly string[],
  options: LintGuardOptions,
): Promise<LintGuardResult> {
  const cwd = options.cwd ?? process.cwd();
  const byPackage = new Map<LintGuardPackage, string[]>();
  for (const file of changedFiles) {
    const pkg = classifyLintGuardPackage(file);
    const list = byPackage.get(pkg);
    if (list) list.push(file);
    else byPackage.set(pkg, [file]);
  }

  const checks: LintGuardCheckResult[] = [];
  for (const [pkg, files] of byPackage) {
    checks.push(...(await runPackageCheck(pkg, files, options.spawn, cwd)));
  }

  return { ok: checks.every((check) => check.ok), checks };
}

export type LintGuardedDriverResult = CodingAgentDriverResult & { lintGuard: LintGuardResult };

/**
 * Decorate a `CodingAgentDriver` result with its lint-guard verdict. Skips the guard entirely (an empty,
 * passing `lintGuard`) when the driver itself failed or reported no changed files -- there is nothing to
 * check, and running checks against an untouched tree would only produce a misleading unrelated result.
 */
export async function guardCodingAgentDriverResult(
  result: CodingAgentDriverResult,
  options: LintGuardOptions,
): Promise<LintGuardedDriverResult> {
  if (!result.ok || result.changedFiles.length === 0) {
    return { ...result, lintGuard: { ok: true, checks: [] } };
  }
  const lintGuard = await guardChangedFiles(result.changedFiles, options);
  return { ...result, ok: result.ok && lintGuard.ok, lintGuard };
}
