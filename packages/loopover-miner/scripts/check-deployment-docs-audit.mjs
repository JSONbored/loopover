#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertDeploymentDocsInSync,
  extractEnvVarClaims,
  extractFilePathClaims,
  extractSubcommandClaims,
  scanEnvVarTokens,
  scanRegisteredCommands,
} from "../lib/deployment-docs-audit.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MINER_DIR = resolve(REPO_ROOT, "packages/loopover-miner");
const DEPLOYMENT_MD = resolve(MINER_DIR, "DEPLOYMENT.md");
const BIN_DIR = resolve(MINER_DIR, "bin");
const BIN_ENTRY = resolve(BIN_DIR, "loopover-miner.js");
const LIB_DIR = resolve(MINER_DIR, "lib");
const ENGINE_MINER_DIR = resolve(REPO_ROOT, "packages/loopover-engine/src/miner");

function readFilesWithExtension(dir, extension) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

function buildLiveReality() {
  const envReads = scanEnvVarTokens(
    [
      ...readFilesWithExtension(LIB_DIR, ".js"),
      ...readFilesWithExtension(BIN_DIR, ".js"),
      ...readFilesWithExtension(ENGINE_MINER_DIR, ".ts"),
    ].join("\n"),
  );
  const registered = scanRegisteredCommands(readFileSync(BIN_ENTRY, "utf8"));
  return {
    hasEnvRead: (name) => envReads.has(name),
    pathExists: (relativePath) => existsSync(resolve(MINER_DIR, relativePath)),
    isRegisteredCommand: (name) => registered.has(name),
  };
}

function applyTestMode(reality) {
  const mode = process.env.CHECK_MINER_DEPLOYMENT_DOCS_AUDIT_TEST_MODE;
  if (!mode) return reality;
  if (mode === "missing-env") return { ...reality, hasEnvRead: () => false };
  if (mode === "missing-path") return { ...reality, pathExists: () => false };
  if (mode === "missing-command") return { ...reality, isRegisteredCommand: () => false };
  return reality;
}

export function runDeploymentDocsAuditCheck() {
  const markdown = readFileSync(DEPLOYMENT_MD, "utf8");
  const claims = {
    envVars: extractEnvVarClaims(markdown),
    filePaths: extractFilePathClaims(markdown),
    subcommands: extractSubcommandClaims(markdown),
  };
  const result = assertDeploymentDocsInSync(claims, applyTestMode(buildLiveReality()));
  return `Miner deployment docs audit ok: ${claims.envVars.length} env vars, ${claims.filePaths.length} paths, ${claims.subcommands.length} subcommands checked.\n`;
}

function main() {
  try {
    process.stdout.write(runDeploymentDocsAuditCheck());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
