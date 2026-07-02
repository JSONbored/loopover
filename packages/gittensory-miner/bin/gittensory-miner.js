#!/usr/bin/env node
import { createRequire } from "node:module";
import { printHelp, printVersion, runCli } from "../lib/cli.js";
import {
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
});

if (
  cliArgs.length === 0 ||
  cliArgs.includes("--help") ||
  cliArgs.includes("-h") ||
  cliArgs[0] === "help"
) {
  printHelp({ packageName });
  process.exit(0);
}

if (
  cliArgs.includes("--version") ||
  cliArgs.includes("-v") ||
  cliArgs[0] === "version"
) {
  printVersion({ packageName, packageVersion });
  process.exit(0);
}

const exitCode = runCli(cliArgs, { packageName });
await updateCheck;
process.exit(exitCode);
