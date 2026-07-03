#!/usr/bin/env node
import { createRequire } from "node:module";
import { printHelp, printVersion, runCli } from "../lib/cli.js";
import { runDenyCheck } from "../lib/deny-check.js";
import { runStateCli } from "../lib/run-state-cli.js";
import { runDoctor, runStatus } from "../lib/status.js";
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

if (cliArgs[0] === "state") {
  const exitCode = runStateCli(cliArgs[1], cliArgs.slice(2));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

if (cliArgs[0] === "status") {
  const exitCode = runStatus(cliArgs.slice(1));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

if (cliArgs[0] === "doctor") {
  const exitCode = runDoctor(cliArgs.slice(1));
  await awaitOpportunisticUpdateCheck(updateCheck);
  process.exit(exitCode);
}

const exitCode = runCli(cliArgs, { packageName });
await awaitOpportunisticUpdateCheck(updateCheck);
process.exit(exitCode);
