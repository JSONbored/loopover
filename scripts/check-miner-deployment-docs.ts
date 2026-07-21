// CI entrypoint for the miner DEPLOYMENT.md accuracy audit (#6158). The pure checker lives in
// packages/loopover-miner/lib/deployment-docs-audit.ts; this script builds live reality from the
// miner + engine trees and fails non-zero on drift so validate-code / test:ci catch renames.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  assertDeploymentDocsInSync,
  extractEnvVarClaims,
  extractFilePathClaims,
  extractSubcommandClaims,
  scanEnvVarTokens,
  scanRegisteredCommands,
  type DeploymentDocsReality,
} from "../packages/loopover-miner/lib/deployment-docs-audit.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MINER_DIR = resolve(REPO_ROOT, "packages/loopover-miner");
const DEPLOYMENT_MD = resolve(MINER_DIR, "DEPLOYMENT.md");
const BIN_DIR = resolve(MINER_DIR, "bin");
const BIN_ENTRY = resolve(BIN_DIR, "loopover-miner.js");
const LIB_DIR = resolve(MINER_DIR, "lib");
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

export type MinerDeploymentAuditResult = {
  ok: boolean;
  failures: string[];
  claimCounts: {
    envVars: number;
    filePaths: number;
    subcommands: number;
  };
};

/** Run the live DEPLOYMENT.md audit. */
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
  return {
    ok: result.ok,
    failures: result.failures,
    claimCounts: {
      envVars: claims.envVars.length,
      filePaths: claims.filePaths.length,
      subcommands: claims.subcommands.length,
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
    io.log(`Miner deployment docs audit ok: ${result.claimCounts.envVars} env vars, ${result.claimCounts.filePaths} paths, ${result.claimCounts.subcommands} subcommands.`);
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.exit(1);
    return 1;
  }
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
