#!/usr/bin/env node
import { runAttempt } from "../lib/attempt-cli.js";
import { printHelp, printVersion, runCli } from "../lib/cli.js";
import { loadMinerFileSecrets } from "../lib/load-file-secrets.js";
import { configureLogger, extractLogOptions } from "../lib/logger.js";
import { runDenyCheck } from "../lib/deny-check.js";
import { runDiscover } from "../lib/discover-cli.js";
import { runFeasibilityCli } from "../lib/feasibility-cli.js";
import { runGovernorCli } from "../lib/governor-ledger-cli.js";
import { runLedgerCli } from "../lib/event-ledger-cli.js";
import { runCalibrationCli } from "../lib/calibration-cli.js";
import { runLoop } from "../lib/loop-cli.js";
import { runManagePoll } from "../lib/manage-poll.js";
import { runManageStatus } from "../lib/manage-status.js";
import { runMetrics } from "../lib/metrics-cli.js";
import { runPlanCli } from "../lib/plan-store-cli.js";
import { runClaimCli } from "../lib/claim-ledger-cli.js";
import { runQueueCli } from "../lib/portfolio-queue-cli.js";
import { runOrbExportCli } from "../lib/orb-export.js";
import { installCliSignalHandlers } from "../lib/process-lifecycle.js";
import { runStateCli } from "../lib/run-state-cli.js";
import { runInit } from "../lib/laptop-init.js";
import { runMigrate } from "../lib/migrate-cli.js";
import { runDoctor, runStatus } from "../lib/status.js";
import {
  awaitOpportunisticUpdateCheck,
  resolveUpgradeCommand,
  startUpdateCheck,
} from "../lib/update-check.js";
import { resolveMinerVersion } from "../lib/version.js";

// Register signal + crash handlers once, before any command runs, so an interrupted run closes its open ledgers
// cleanly instead of dying mid-write (#4826). Covers every subcommand below, including the local ones.
installCliSignalHandlers();

// Resolve any `<NAME>_FILE` secret-file companions (GITHUB_TOKEN today) into their plain env vars once, before
// any command reads a credential (#5178), so a Docker/Swarm/K8s secret mount works exactly like a plain env
// var. Fail-fast with a clear message (never the secret value) so a missing/unreadable/empty mounted secret
// surfaces here rather than as a confusing downstream GitHub auth failure.
try {
  loadMinerFileSecrets(process.env);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// Peel the global logging flags (--quiet/--verbose/--log-level) off the front of argv and configure the
// process-wide logger once (#4835), so every command below shares one level-aware logger without re-parsing
// them; the stripped `cliArgs` is what the command dispatch sees.
const { options: logOptions, rest: cliArgs } = extractLogOptions(process.argv.slice(2));
configureLogger({ ...logOptions, env: process.env });

// `status` and `doctor` are strictly local, offline commands — their contract is to make NO network calls.
// `init` stays local by default and only makes a network call when the operator explicitly passes
// `--verify-token`.
// Dispatch the local commands BEFORE the opportunistic npm-registry update check is even started, so they can
// never reach that network path (the update check runs for the remaining commands below).
if (cliArgs[0] === "init") {
  process.exit(await runInit(cliArgs.slice(1)));
}

if (cliArgs[0] === "status") {
  process.exit(runStatus(cliArgs.slice(1)));
}

if (cliArgs[0] === "doctor") {
  process.exit(runDoctor(cliArgs.slice(1)));
}

// `migrate` is strictly local + offline like `status`/`doctor` (it only opens the local SQLite stores), so it is
// dispatched here too, before the opportunistic npm-registry update check is ever started.
if (cliArgs[0] === "migrate") {
  process.exit(runMigrate(cliArgs.slice(1)));
}

// `metrics` is strictly local + offline like `status`/`doctor` (it reads only the local prediction ledger), so it
// is dispatched here, before the opportunistic npm-registry update check is ever started.
if (cliArgs[0] === "metrics") {
  process.exit(runMetrics(cliArgs.slice(1)));
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

if (cliArgs[0] === "calibration") {
  process.exit(runCalibrationCli(cliArgs.slice(1)));
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
