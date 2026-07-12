#!/usr/bin/env node
import { runAttempt } from "../lib/attempt-cli.js";
import { printHelp, printVersion, runCli } from "../lib/cli.js";
import { runDenyCheck } from "../lib/deny-check.js";
import { runDiscover } from "../lib/discover-cli.js";
import { runFeasibilityCli } from "../lib/feasibility-cli.js";
import { runGovernorCli } from "../lib/governor-ledger-cli.js";
import { runLedgerCli } from "../lib/event-ledger-cli.js";
import { runLoop } from "../lib/loop-cli.js";
import { runManagePoll } from "../lib/manage-poll.js";
import { runManageStatus } from "../lib/manage-status.js";
import { runPlanCli } from "../lib/plan-store-cli.js";
import { runClaimCli } from "../lib/claim-ledger-cli.js";
import { runQueueCli } from "../lib/portfolio-queue-cli.js";
import { runOrbExportCli } from "../lib/orb-export.js";
import { runStateCli } from "../lib/run-state-cli.js";
import { runInit } from "../lib/laptop-init.js";
import { runDoctor, runStatus } from "../lib/status.js";
import {
  awaitOpportunisticUpdateCheck,
  resolveUpgradeCommand,
  startUpdateCheck,
} from "../lib/update-check.js";
import { resolveMinerVersion } from "../lib/version.js";
import { loadMinerFileCredentials } from "../lib/load-file-credentials.js";

// Resolve `<NAME>_FILE` secret-file indirection (#5178) BEFORE any command reads GITHUB_TOKEN or a coding-agent
// credential, so a fleet operator can mount them as Docker/Swarm/Kubernetes secrets instead of passing plaintext
// env vars visible via `docker inspect`. A no-op when no `_FILE` companion is set (the common case).
loadMinerFileCredentials();

const cliArgs = process.argv.slice(2);

// `init`, `status`, and `doctor` are strictly local, offline commands — their contract is to make NO network calls.
// Dispatch them BEFORE the opportunistic npm-registry update check is even started, so they can never reach that
// network path (the update check runs for the remaining commands below).
if (cliArgs[0] === "init") {
  process.exit(runInit(cliArgs.slice(1)));
}

if (cliArgs[0] === "status") {
  process.exit(runStatus(cliArgs.slice(1)));
}

if (cliArgs[0] === "doctor") {
  process.exit(runDoctor(cliArgs.slice(1)));
}

if (cliArgs[0] === "manage" && cliArgs[1] === "status") {
  process.exit(runManageStatus(cliArgs.slice(2)));
}

if (cliArgs[0] === "queue") {
  process.exit(runQueueCli(cliArgs[1], cliArgs.slice(2)));
}

if (cliArgs[0] === "orb" && cliArgs[1] === "export") {
  process.exit(runOrbExportCli(cliArgs.slice(2)));
}

if (cliArgs[0] === "claim") {
  process.exit(runClaimCli(cliArgs[1], cliArgs.slice(2)));
}

if (cliArgs[0] === "ledger") {
  process.exit(runLedgerCli(cliArgs[1], cliArgs.slice(2)));
}

if (cliArgs[0] === "plan") {
  process.exit(runPlanCli(cliArgs[1], cliArgs.slice(2)));
}

if (cliArgs[0] === "governor") {
  process.exit(await runGovernorCli(cliArgs[1], cliArgs.slice(2)));
}

if (cliArgs[0] === "feasibility") {
  process.exit(runFeasibilityCli(cliArgs.slice(1)));
}

const packageName = "@jsonbored/gittensory-miner";
const packageVersion = resolveMinerVersion(process.env);
const upgradeCommand = resolveUpgradeCommand(packageName);

const updateCheck = startUpdateCheck(cliArgs, {
  packageName,
  packageVersion,
  upgradeCommand,
  env: process.env,
});

if (
  cliArgs.length === 0 ||
  cliArgs.includes("--help") ||
  cliArgs.includes("-h") ||
  cliArgs[0] === "help"
) {
  printHelp({ packageName });
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(0);
}

if (
  cliArgs.includes("--version") ||
  cliArgs.includes("-v") ||
  cliArgs[0] === "version"
) {
  printVersion({ packageName, packageVersion });
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(0);
}

if (cliArgs[0] === "hooks" && cliArgs[1] === "check") {
  const exitCode = runDenyCheck(cliArgs.slice(2));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

if (cliArgs[0] === "state") {
  const exitCode = runStateCli(cliArgs[1], cliArgs.slice(2));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

if (cliArgs[0] === "manage" && cliArgs[1] === "poll") {
  const exitCode = await runManagePoll(cliArgs.slice(2));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

if (cliArgs[0] === "discover") {
  const exitCode = await runDiscover(cliArgs.slice(1));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

if (cliArgs[0] === "attempt") {
  const exitCode = await runAttempt(cliArgs.slice(1));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

if (cliArgs[0] === "loop") {
  const exitCode = await runLoop(cliArgs.slice(1));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

const exitCode = runCli(cliArgs, { packageName });
await awaitOpportunisticUpdateCheck(updateCheck);
process.exit(exitCode);
