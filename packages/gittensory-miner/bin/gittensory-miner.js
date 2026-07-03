#!/usr/bin/env node
import { createRequire } from "node:module";
import { printHelp, printVersion, runCli } from "../lib/cli.js";
import { runDenyCheck } from "../lib/deny-check.js";
import {
  awaitOpportunisticUpdateCheck,
  resolveUpgradeCommand,
  startUpdateCheck,
} from "../lib/update-check.js";

const cliArgs = process.argv.slice(2);
const require = createRequire(import.meta.url);
const packageName = "@jsonbored/gittensory-miner";
const packageVersion = require("../package.json").version;
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

if (cliArgs[0] === "status") {
  const { listQueue } = await import("../lib/portfolio-queue.js");
  const { readEvents } = await import("../lib/event-ledger.js");
  const { parseManageStatusArgs, runManageStatus } = await import("../lib/manage-status.js");
  try {
    const options = parseManageStatusArgs(cliArgs.slice(1));
    const result = runManageStatus({ listQueue, readEvents }, options);
    process.stdout.write(result.output);
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(result.exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : "manage_status_failed";
    console.error(`status failed: ${message}`);
    await awaitOpportunisticUpdateCheck(updateCheck);
    process.exit(1);
  }
}

const exitCode = runCli(cliArgs, { packageName });
await awaitOpportunisticUpdateCheck(updateCheck);
process.exit(exitCode);
