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
import { awaitOpportunisticUpdateCheck, resolveUpgradeCommand, startUpdateCheck, } from "../lib/update-check.js";
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
}
catch (error) {
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
        }
        finally {
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
if (cliArgs.length === 0 ||
    cliArgs.includes("--help") ||
    cliArgs.includes("-h") ||
    cliArgs[0] === "help") {
    printHelp({ packageName });
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(0);
}
if (cliArgs.includes("--version") ||
    cliArgs.includes("-v") ||
    cliArgs[0] === "version") {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcG92ZXItbWluZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsb29wb3Zlci1taW5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQ0EsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ25ELE9BQU8sRUFBRSxTQUFTLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxNQUFNLGVBQWUsQ0FBQztBQUNoRSxPQUFPLEVBQUUsZUFBZSxFQUFFLGlCQUFpQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDdEUsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQ3BELE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUNyRCxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSwyQkFBMkIsQ0FBQztBQUM5RCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxnQ0FBZ0MsQ0FBQztBQUN2RSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDL0QsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBQzFELE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQzlELE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUM3QyxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDdEQsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBQzFELE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUNuRCxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sMEJBQTBCLENBQUM7QUFDdEQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBQ3pELE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUMvQyxPQUFPLEVBQUUsV0FBVyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQ3ZELE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNwRCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFDMUQsT0FBTyxFQUFFLHdCQUF3QixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFDdkUsT0FBTyxFQUFFLHlCQUF5QixFQUFFLGVBQWUsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQzlFLE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUN0RCxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDaEQsT0FBTyxFQUFFLGNBQWMsRUFBRSxrQkFBa0IsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQzNFLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLGdDQUFnQyxDQUFDO0FBQ3RFLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUNuRCxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ3hELE9BQU8sRUFDTCw2QkFBNkIsRUFDN0IscUJBQXFCLEVBQ3JCLGdCQUFnQixHQUNqQixNQUFNLHdCQUF3QixDQUFDO0FBQ2hDLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXhELDZHQUE2RztBQUM3Ryw2R0FBNkc7QUFDN0csK0dBQStHO0FBQy9HLHlHQUF5RztBQUN6Ryx5R0FBeUc7QUFDekcsNkdBQTZHO0FBQzdHLHdHQUF3RztBQUN4RyxJQUFJLENBQUM7SUFDSCxvQkFBb0IsRUFBRSxDQUFDO0FBQ3pCLENBQUM7QUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO0lBQ2YsT0FBTyxDQUFDLEtBQUssQ0FBQyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN0RSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUM7QUFFRCw4R0FBOEc7QUFDOUcsK0dBQStHO0FBQy9HLDBDQUEwQztBQUMxQzs7Ozs7OEZBSzhGO0FBQzlGLE1BQU0sZUFBZSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUVuQyxnSEFBZ0g7QUFDaEgsdUdBQXVHO0FBQ3ZHLHdCQUF3QixDQUFDLEVBQUUsWUFBWSxFQUFFLHlCQUF5QixFQUFFLENBQUMsQ0FBQztBQUN0RSxvQkFBb0I7QUFFcEIsd0dBQXdHO0FBQ3hHLDRHQUE0RztBQUM1RyxrRUFBa0U7QUFDbEUsTUFBTSxFQUFFLE9BQU8sRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxHQUFHLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEYsZUFBZSxDQUFDLEVBQUUsR0FBRyxVQUFVLEVBQUUsR0FBRyxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO0FBRXJELDJHQUEyRztBQUMzRyxrR0FBa0c7QUFDbEcsb0JBQW9CO0FBQ3BCLDhHQUE4RztBQUM5RywwRkFBMEY7QUFDMUYsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssTUFBTSxFQUFFLENBQUM7SUFDMUIsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFLENBQUM7UUFDdEMsTUFBTSxRQUFRLEdBQUcsY0FBYyxFQUFFLENBQUM7UUFDbEMsSUFBSSxDQUFDO1lBQ0gsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLGtCQUFrQixDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUcsRUFBRSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFDL0UsQ0FBQztnQkFBUyxDQUFDO1lBQ1QsUUFBUSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ25CLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLE9BQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNoRCxDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxFQUFFLENBQUM7SUFDNUIsT0FBTyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDNUMsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFFBQVEsRUFBRSxDQUFDO0lBQzVCLE9BQU8sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzVDLENBQUM7QUFFRCxpSEFBaUg7QUFDakgsMkZBQTJGO0FBQzNGLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFNBQVMsRUFBRSxDQUFDO0lBQzdCLE9BQU8sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzdDLENBQUM7QUFFRCxrSEFBa0g7QUFDbEgsMEZBQTBGO0FBQzFGLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFNBQVMsRUFBRSxDQUFDO0lBQzdCLE9BQU8sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzdDLENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxRQUFRLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFFBQVEsRUFBRSxDQUFDO0lBQ3ZELE9BQU8sQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xELENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxPQUFPLEVBQUUsQ0FBQztJQUMzQixPQUFPLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUQsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLEtBQUssSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxFQUFFLENBQUM7SUFDcEQsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLGVBQWUsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsNkdBQTZHO0FBQzdHLDJHQUEyRztBQUMzRyxzR0FBc0c7QUFDdEcsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxFQUFFLENBQUM7SUFDNUIsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLFlBQVksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakUsQ0FBQztBQUVELG9HQUFvRztBQUNwRyw2R0FBNkc7QUFDN0csbUZBQW1GO0FBQ25GLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLGFBQWEsRUFBRSxDQUFDO0lBQ2pDLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxhQUFhLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEQsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLE9BQU8sRUFBRSxDQUFDO0lBQzNCLE9BQU8sQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxRCxDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxFQUFFLENBQUM7SUFDNUIsT0FBTyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNELENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxhQUFhLEVBQUUsQ0FBQztJQUNqQyxPQUFPLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3BELENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxNQUFNLEVBQUUsQ0FBQztJQUMxQixPQUFPLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDekQsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFVBQVUsRUFBRSxDQUFDO0lBQzlCLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxjQUFjLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25FLENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxhQUFhLEVBQUUsQ0FBQztJQUNqQyxPQUFPLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3BELENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxrQkFBa0IsRUFBRSxDQUFDO0lBQ3RDLE9BQU8sQ0FBQyxJQUFJLENBQUMscUJBQXFCLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELCtHQUErRztBQUMvRywrR0FBK0c7QUFDL0csSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssT0FBTyxFQUFFLENBQUM7SUFDM0IsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELE1BQU0sV0FBVyxHQUFHLGlCQUFpQixDQUFDO0FBQ3RDLE1BQU0sY0FBYyxHQUFHLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN4RCxNQUFNLGNBQWMsR0FBRyxxQkFBcUIsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUUxRCxNQUFNLFdBQVcsR0FBRyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUU7SUFDNUMsV0FBVztJQUNYLGNBQWM7SUFDZCxjQUFjO0lBQ2QsR0FBRyxFQUFFLE9BQU8sQ0FBQyxHQUFHO0NBQ2pCLENBQUMsQ0FBQztBQUVILElBQ0UsT0FBTyxDQUFDLE1BQU0sS0FBSyxDQUFDO0lBQ3BCLE9BQU8sQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDO0lBQzFCLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO0lBQ3RCLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxNQUFNLEVBQ3JCLENBQUM7SUFDRCxTQUFTLENBQUMsRUFBRSxXQUFXLEVBQUUsQ0FBQyxDQUFDO0lBQzNCLE1BQU0sNkJBQTZCLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDakQsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNsQixDQUFDO0FBRUQsSUFDRSxPQUFPLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQztJQUM3QixPQUFPLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQztJQUN0QixPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssU0FBUyxFQUN4QixDQUFDO0lBQ0QsWUFBWSxDQUFDLEVBQUUsV0FBVyxFQUFFLGNBQWMsRUFBRSxDQUFDLENBQUM7SUFDOUMsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLE9BQU8sRUFBRSxDQUFDO0lBQ3JELE1BQU0sUUFBUSxHQUFHLFlBQVksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDaEQsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ3pCLENBQUM7QUFFRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxPQUFPLEVBQUUsQ0FBQztJQUMzQixNQUFNLFFBQVEsR0FBRyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzRCxNQUFNLDZCQUE2QixDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ2pELE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDekIsQ0FBQztBQUVELElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLFFBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssTUFBTSxFQUFFLENBQUM7SUFDckQsTUFBTSxRQUFRLEdBQUcsTUFBTSxhQUFhLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3ZELE1BQU0sNkJBQTZCLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDakQsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssVUFBVSxFQUFFLENBQUM7SUFDOUIsTUFBTSxRQUFRLEdBQUcsTUFBTSxXQUFXLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3JELE1BQU0sNkJBQTZCLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDakQsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssU0FBUyxFQUFFLENBQUM7SUFDN0IsTUFBTSxRQUFRLEdBQUcsTUFBTSxVQUFVLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3BELE1BQU0sNkJBQTZCLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDakQsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssTUFBTSxFQUFFLENBQUM7SUFDMUIsTUFBTSxRQUFRLEdBQUcsTUFBTSxPQUFPLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2pELE1BQU0sNkJBQTZCLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDakQsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLE9BQU8sRUFBRSxFQUFFLFdBQVcsRUFBRSxDQUFDLENBQUM7QUFDbEQsTUFBTSw2QkFBNkIsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUNqRCxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDIn0=