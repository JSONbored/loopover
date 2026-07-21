#!/usr/bin/env node
// Fails fast, with a clear message, when the running Node doesn't satisfy root package.json's
// engines.node -- even when node_modules is already installed. The root .npmrc's engine-strict=true only
// fires during npm install/ci (dependency resolution); a node_modules installed while on the pinned Node,
// followed by simply switching the active `node` (nvm/homebrew default change) with no reinstall, sails
// straight past engine-strict on every later `npm run`. That's exactly the shape of gap that let the
// Node 26 jsdom/localStorage bug (#7592/#7597/#7612) go unnoticed the first two times: a pile of
// confusing downstream test failures instead of one clear "wrong Node version" message up front. Wired as
// a `pretest*` hook (see package.json) on the commands people actually run vitest through.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import semver from "semver";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);

export function checkNodeVersion({ nodeVersion = process.version, readFile = () => readFileSync(PACKAGE_JSON_URL, "utf8") } = {}) {
  const pkg = JSON.parse(readFile());
  const requiredRange = pkg.engines?.node;
  if (!requiredRange) return { ok: true, requiredRange: undefined };

  const ok = semver.satisfies(nodeVersion, requiredRange);
  return { ok, requiredRange, nodeVersion };
}

function main() {
  const { ok, requiredRange, nodeVersion } = checkNodeVersion();
  if (!ok) {
    console.error(
      `\nRunning Node ${nodeVersion}, but this repo requires ${requiredRange} (see .nvmrc / package.json engines).\n` +
        `Switch to the pinned Node version (e.g. \`nvm use\`) before running this command.\n`,
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
