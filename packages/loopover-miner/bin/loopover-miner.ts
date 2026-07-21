#!/usr/bin/env node
import { runAttempt } from "../lib/attempt-cli.js";
import { printHelp, printVersion, runCli } from "../lib/cli.js";
import { configureLogger, extractLogOptions } from "../lib/logger.js";
import { runDenyCheck } from "../lib/deny-check.js";
import { runDiscover } from "../lib/discover-cli.js";
import { runFeasibilityCli } from "../lib/feasibility-cli.js";
import { runIdeaFeasibilityCli } from "../lib/idea-feasibility-cli.js";
import { runGovernorCli } from "../lib/governor-ledger-cli.js";
import { runLedgerCli } from "../lib/event-ledger-cli.js";
import { runCalibrationCli } from "../lib/calibration-cli.js";
import { runLoop } from "../lib/loop-cli.js";
import { runManagePoll } from "../lib/manage-poll.js";
import { runManageStatus } from "../lib/manage-status.js";
import { runMetrics } from "../lib/metrics-cli.js";
import { runPlanCli } from "../lib/plan-store-cli.js";
import { runClaimCli } from "../lib/claim-ledger-cli.js";
import { runPurge } from "../lib/purge-cli.js";
import { runQueueCli } from "../lib/portfolio-queue-cli.js";
import { runOrbExportCli } from "../lib/orb-export.js";
import { runTenantCli } from "../lib/tenant-cli.js";
import { runPrOutcomes } from "../lib/pr-outcomes-cli.js";
import { installCliSignalHandlers } from "../lib/process-lifecycle.js";
import { captureMinerErrorAndFlush, initMinerSentry } from "../lib/sentry.js";
import { runStateCli } from "../lib/run-state-cli.js";
import { runInit } from "../lib/laptop-init.js";
import { createWizardIo, runInteractiveInit } from "../lib/init-wizard.js";
import { loadMinerFileSecrets } from "../lib/env-file-indirection.js";
import { runMigrate } from "../lib/migrate-cli.js";
import { runDoctor, runStatus } from "../lib/status.js";
import {
  awaitOpportunisticUpdateCheck,
  resolveUpgradeCommand,
  startUpdateCheck,
} from "../lib/update-check.js";
import { resolveMinerVersion } from "../lib/version.js";

// Resolve any `<NAME>_FILE` secret-mount vars (GITHUB_TOKEN_FILE, etc.) into their plain counterparts FIRST,
// before anything else reads process.env -- every subcommand below (and the coding-agent driver construction
// deeper in the call graph) reads plain env vars, so this single early pass is all that's needed for the whole
// CLI (#5178). A broken secret mount fails the process fast and loud with a clear message, instead of an
// uncaught-exception stack trace or a silent empty credential surfacing as a confusing GitHub 401 later.
// Exits 2, not 1: docs/unattended-scheduling.md's contract only defines 0 (success) and 2 (failure -- "Alert
// on this"), so an operator alerting strictly on 2 would otherwise miss a broken secret mount entirely.
try {
  loadMinerFileSecrets();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

// Opt-in Sentry (#6011): a complete no-op unless the operator sets LOOPOVER_MINER_SENTRY_DSN themselves. Must
// run AFTER loadMinerFileSecrets (so a `_FILE`-mounted DSN resolves first) and BEFORE installCliSignalHandlers
// (so a startup crash is still captured).
/* v8 ignore start -- process entry point (this bin's top level runs unconditionally, every invocation);
 * exercised by the real --help/--version subprocess spawn in miner-package-skeleton.test.ts (a different
 * Node process, invisible to this test run's own coverage instrumentation), not unit-coverable here. The
 * functions themselves (initMinerSentry, installCliSignalHandlers) are fully unit-tested in isolation
 * (miner-sentry.test.ts, miner-process-lifecycle.test.ts) -- this is only the top-level wiring that calls
 * them, mirroring src/server.ts's identical, already-established exemption in codecov.yml. */
await initMinerSentry(process.env);

// Register signal + crash handlers once, before any command runs, so an interrupted run closes its open ledgers
// cleanly instead of dying mid-write (#4826). Covers every subcommand below, including the local ones.
installCliSignalHandlers({ captureError: captureMinerErrorAndFlush });
/* v8 ignore stop */

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
  if (cliArgs.includes("--interactive")) {
    const wizardIo = createWizardIo();
    try {
      process.exit(await runInteractiveInit(process.env, process.cwd(), wizardIo));
    } finally {
      wizardIo.close();
    }
  }
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
  process.exit(await runOrbExportCli(cliArgs.slice(2)));
}

// `tenant` (#7275) talks to the hosting control-plane's provisioning API — a deliberate, Bearer-authed admin
// action that is inert unless LOOPOVER_MINER_CONTROL_PLANE is set. Grouped with `orb export` above (also a
// network command) rather than the strictly-local commands; it fails loud on any control-plane error.
if (cliArgs[0] === "tenant") {
  process.exit(await runTenantCli(cliArgs[1], cliArgs.slice(2)));
}

// `pr-outcomes` (#7658) reads the current miner's own post-merge PR-outcome history from the hosted
// `GET /v1/contributors/:login/pr-outcomes` endpoint; a network command like `orb export`/`tenant` above, it
// fails loud on any backend error and needs an authenticated loopover-mcp session.
if (cliArgs[0] === "pr-outcomes") {
  process.exit(await runPrOutcomes(cliArgs.slice(1)));
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

if (cliArgs[0] === "idea-feasibility") {
  process.exit(runIdeaFeasibilityCli(cliArgs.slice(1)));
}

// `purge` (#5564) is strictly local + offline like `queue`/`claim`/`governor` above -- it only opens the local
// SQLite stores, so it is dispatched here too, before the opportunistic npm-registry update check ever starts.
if (cliArgs[0] === "purge") {
  process.exit(runPurge(cliArgs.slice(1)));
}

const packageName = "@loopover/miner";
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
