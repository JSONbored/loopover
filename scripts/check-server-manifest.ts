// server.json validation + the ANTI-ROT guard (#9526).
//
// metagraphed's version-sync workflow rotted silently for months because it watched a file path that no
// longer existed: the workflow kept passing while doing nothing. That is the failure this script exists to
// make impossible here, so it does two jobs:
//
//   1. Field-by-field validation of server.json against the live sources — the version must equal
//      @loopover/mcp's package.json version, the npm identifier must be that package's real name, and the
//      remote must point at the deployment the server card advertises.
//   2. WATCHED-PATH existence. Every path this check and the publish workflow depend on is listed here and
//      asserted to exist in the working tree. A rename that leaves the list behind fails loudly instead of
//      quietly watching nothing.
//
// Wired into test:ci, so a stale manifest cannot reach main and the publish workflow cannot be pointed at a
// file that has moved.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every path the manifest check and the publish workflow read. Listed once, asserted to exist. Adding a
 * watched path here without creating it is the same loud failure as deleting one.
 */
export const WATCHED_PATHS = [
  "server.json",
  "packages/loopover-mcp/package.json",
  ".github/workflows/publish-mcp-registry.yml",
] as const;

export type ManifestProblem = { field: string; detail: string };

type ServerManifest = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  repository?: { url?: unknown; source?: unknown };
  remotes?: Array<{ type?: unknown; url?: unknown }>;
  packages?: Array<{ registry_type?: unknown; identifier?: unknown; version?: unknown; transport?: { type?: unknown } }>;
};

export const EXPECTED_SERVER_NAME = "io.github.JSONbored/loopover";
export const EXPECTED_REMOTE_URL = "https://api.loopover.ai/mcp";
export const EXPECTED_PACKAGE_NAME = "@loopover/mcp";

export function checkWatchedPaths(deps: { exists?: (path: string) => boolean } = {}): ManifestProblem[] {
  const exists = deps.exists ?? existsSync;
  return WATCHED_PATHS.filter((path) => !exists(path)).map((path) => ({
    field: "watched-path",
    detail: `${path} is watched by the manifest check or the publish workflow but does not exist — a rename left this list behind`,
  }));
}

/**
 * Validate the manifest against the package that actually ships.
 *
 * The version is the point: it is NOT hand-maintained here. It must equal `@loopover/mcp`'s version, which
 * the existing release automation bumps, so publishing can never advertise a version nobody released.
 */
export function checkServerManifest(manifestJson: string, mcpPackageJson: string): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  let manifest: ServerManifest;
  try {
    manifest = JSON.parse(manifestJson) as ServerManifest;
  } catch (error) {
    return [{ field: "server.json", detail: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const mcpPackage = JSON.parse(mcpPackageJson) as { name?: string; version?: string };

  if (manifest.name !== EXPECTED_SERVER_NAME) {
    problems.push({ field: "name", detail: `expected ${EXPECTED_SERVER_NAME}, got ${String(manifest.name)}` });
  }
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    problems.push({ field: "description", detail: "must be a non-empty string — registry listings show it verbatim" });
  }
  if (manifest.repository?.url !== "https://github.com/JSONbored/loopover" || manifest.repository?.source !== "github") {
    problems.push({ field: "repository", detail: "must point at github.com/JSONbored/loopover with source: github" });
  }
  if (manifest.version !== mcpPackage.version) {
    problems.push({
      field: "version",
      detail: `must equal @loopover/mcp's ${String(mcpPackage.version)} (release automation owns it), got ${String(manifest.version)}`,
    });
  }

  const remote = manifest.remotes?.[0];
  if (!remote || remote.type !== "streamable-http" || remote.url !== EXPECTED_REMOTE_URL) {
    problems.push({ field: "remotes[0]", detail: `must be a streamable-http remote at ${EXPECTED_REMOTE_URL}` });
  }
  if ((manifest.remotes?.length ?? 0) !== 1) {
    problems.push({ field: "remotes", detail: "must declare exactly one remote — a second entry is a second front door nobody tests" });
  }

  const npmPackage = manifest.packages?.[0];
  if (!npmPackage || npmPackage.registry_type !== "npm" || npmPackage.identifier !== (mcpPackage.name ?? EXPECTED_PACKAGE_NAME)) {
    problems.push({ field: "packages[0]", detail: `must be the npm package ${String(mcpPackage.name)}` });
  }
  if (npmPackage && npmPackage.version !== mcpPackage.version) {
    problems.push({ field: "packages[0].version", detail: `must equal @loopover/mcp's ${String(mcpPackage.version)}, got ${String(npmPackage.version)}` });
  }
  if (npmPackage?.transport?.type !== "stdio") {
    problems.push({ field: "packages[0].transport", detail: "the npm package is the stdio entry point" });
  }

  return problems;
}

export function collectProblems(deps: { readFile?: (path: string) => string; exists?: (path: string) => boolean } = {}): ManifestProblem[] {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const pathProblems = checkWatchedPaths(deps);
  // A missing file makes every field check meaningless, so report the rot and stop.
  if (pathProblems.length > 0) return pathProblems;
  return checkServerManifest(readFile("server.json"), readFile("packages/loopover-mcp/package.json"));
}

function main(): void {
  const problems = collectProblems();
  if (problems.length === 0) {
    process.stdout.write(`server.json: OK (${WATCHED_PATHS.length} watched paths present)\n`);
    return;
  }
  process.stderr.write(`server.json has ${problems.length} problem(s) (#9526):\n`);
  for (const problem of problems) process.stderr.write(`  ${problem.field}: ${problem.detail}\n`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
