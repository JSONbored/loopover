// CI entrypoint for the miner DEPLOYMENT.md accuracy audit (#6158). The pure checker lives in
// packages/loopover-miner/lib/deployment-docs-audit.ts; this script builds live reality from the
// miner + engine trees and fails non-zero on drift so validate-code / test:ci catch renames.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  assertContainerCommandsInSync,
  assertDeploymentDocsInSync,
  extractContainerCommandClaim,
  extractEnvVarClaims,
  extractFilePathClaims,
  extractSubcommandClaims,
  scanEnvVarTokens,
  scanRegisteredCommands,
  type ContainerCommandClaim,
  type DeploymentDocsReality,
} from "../packages/loopover-miner/lib/deployment-docs-audit";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MINER_DIR = resolve(REPO_ROOT, "packages/loopover-miner");
const DEPLOYMENT_MD = resolve(MINER_DIR, "DEPLOYMENT.md");
// Fleet-mode container manifests whose command drifting from the real CLI dispatch table is the exact class
// DEPLOYMENT.md's own subcommand audit above already catches for prose -- a manifest built from a stale command
// sets up its container, then immediately exits 1 with "Unknown command: <name>" (see docker-compose.miner.yml
// / k8s/miner-deployment.yaml's own comments for the `run`-was-never-registered regression this guards).
const CONTAINER_MANIFESTS: readonly { source: string; path: string }[] = [
  { source: "packages/loopover-miner/docker-compose.miner.yml", path: resolve(MINER_DIR, "docker-compose.miner.yml") },
  { source: "k8s/miner-deployment.yaml", path: resolve(REPO_ROOT, "k8s/miner-deployment.yaml") },
];
// Scans the compiled dist/ output (2026-07-24 migration; see tsconfig.json's outDir comment) --
// this audit needs a prior `npm run build:miner`, same precondition as everything else that reads
// real compiled artifacts (ci.yml's own "MCP/Miner package check" steps already run after "Build
// miner CLI").
const BIN_DIR = resolve(MINER_DIR, "dist/bin");
const BIN_ENTRY = resolve(BIN_DIR, "loopover-miner.js");
const LIB_DIR = resolve(MINER_DIR, "dist/lib");
const ENGINE_MINER_DIR = resolve(REPO_ROOT, "packages/loopover-engine/src/miner");

function readFilesWithExtension(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

/** Build the live reality predicates used by the audit (exported for unit tests). */
export function buildLiveMinerDeploymentReality(): DeploymentDocsReality {
  const envReads = scanEnvVarTokens([...readFilesWithExtension(LIB_DIR, ".js"), ...readFilesWithExtension(BIN_DIR, ".js"), ...readFilesWithExtension(ENGINE_MINER_DIR, ".ts")].join("\n"));
  const registered = scanRegisteredCommands(readFileSync(BIN_ENTRY, "utf8"));
  return {
    hasEnvRead: (name: string) => envReads.has(name),
    // The full enumerable read-set (#6601), so auditDeploymentDocs can diff the reverse direction — a real
    // `LOOPOVER_MINER_*` read missing from DEPLOYMENT.md — not just probe one documented name at a time.
    envReads,
    pathExists: (relativePath: string) => existsSync(resolve(MINER_DIR, relativePath)),
    isRegisteredCommand: (name: string) => registered.has(name),
  };
}

/** Build the live container-manifest command claims used by the audit (exported for unit tests): each fleet
 *  manifest in CONTAINER_MANIFESTS that has a `command:`/`args:` list, paired with the subcommand it claims. */
export function buildLiveContainerCommandClaims(): ContainerCommandClaim[] {
  const claims: ContainerCommandClaim[] = [];
  for (const manifest of CONTAINER_MANIFESTS) {
    const command = extractContainerCommandClaim(readFileSync(manifest.path, "utf8"));
    if (command !== null) claims.push({ source: manifest.source, command });
  }
  return claims;
}

export type MinerDeploymentAuditResult = {
  ok: boolean;
  failures: string[];
  claimCounts: {
    envVars: number;
    filePaths: number;
    subcommands: number;
    containerCommands: number;
  };
};

/** Run the live DEPLOYMENT.md audit, plus the fleet-mode container-manifest command audit (same drift class,
 *  a different claim source — see docker-compose.miner.yml / k8s/miner-deployment.yaml's own comments). */
export function runMinerDeploymentDocsAudit(opts: { testMode?: string | null; reality?: DeploymentDocsReality } = {}): MinerDeploymentAuditResult {
  const markdown = readFileSync(DEPLOYMENT_MD, "utf8");
  const claims = {
    envVars: extractEnvVarClaims(markdown),
    filePaths: extractFilePathClaims(markdown),
    subcommands: extractSubcommandClaims(markdown),
  };
  let reality = opts.reality ?? buildLiveMinerDeploymentReality();
  if (opts.testMode === "missing-env") {
    const inner = reality;
    reality = {
      ...inner,
      hasEnvRead: () => false,
    };
  }
  const result = assertDeploymentDocsInSync(claims, reality);

  const containerClaims = buildLiveContainerCommandClaims();
  // Test-only fixture (mirrors "missing-env" above): forces every container-manifest command "unregistered"
  // without touching `reality`, so this drift class is exercised independently of the DEPLOYMENT.md audit
  // above -- both currently claim `loop`, so reusing one shared override would mask which audit actually caught
  // the regression.
  const containerReality = opts.testMode === "bad-container-command" ? { ...reality, isRegisteredCommand: () => false } : reality;
  assertContainerCommandsInSync(containerClaims, containerReality);

  return {
    ok: result.ok,
    failures: result.failures,
    claimCounts: {
      envVars: claims.envVars.length,
      filePaths: claims.filePaths.length,
      subcommands: claims.subcommands.length,
      containerCommands: containerClaims.length,
    },
  };
}

export type MinerDeploymentAuditIo = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function main(
  env: Record<string, string | undefined> = process.env,
  io: MinerDeploymentAuditIo = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    exit: (code: number) => process.exit(code),
  },
): number {
  try {
    const result = runMinerDeploymentDocsAudit({
      testMode: env.CHECK_MINER_DEPLOYMENT_DOCS_AUDIT_TEST_MODE ?? null,
    });
    io.log(
      `Miner deployment docs audit ok: ${result.claimCounts.envVars} env vars, ${result.claimCounts.filePaths} paths, ${result.claimCounts.subcommands} subcommands, ${result.claimCounts.containerCommands} container commands.`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.exit(1);
    return 1;
  }
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
