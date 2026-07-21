#!/usr/bin/env node
// Fails fast, with a clear message, when the running Node doesn't satisfy root package.json's
// engines.node -- even when node_modules is already installed. The root .npmrc's engine-strict=true only
// fires during npm install/ci (dependency resolution); a node_modules installed while on the pinned Node,
// followed by simply switching the active `node` (nvm/homebrew default change) with no reinstall, sails
// straight past engine-strict on every later `npm run`. That's exactly the shape of gap that let the
// Node 26 jsdom/localStorage bug (#7592/#7597/#7612) go unnoticed the first two times: a pile of
// confusing downstream test failures instead of one clear "wrong Node version" message up front.
//
// The actual, complete guarantee is test/helpers/vitest-global-setup-node-version.ts, wired as every
// vitest.config.ts's `globalSetup` (root, workers, and every workspace with its own config) -- it covers
// every invocation path, including a direct `npx vitest run test/unit/<file>.test.ts` (which the
// contributing skill docs explicitly recommend for fast iteration), not just specific npm script names.
// This module is ALSO wired as a `pretest*` hook (see package.json) on the highest-traffic commands
// (test, test:ci, test:coverage, test:workers, ui:test) as a genuinely-faster fail there -- it runs
// before npm even spawns vitest, vs. globalSetup which still pays vitest's own startup cost first -- but
// that hook is a nicety on top of the globalSetup guarantee, not a substitute for it; it was originally
// (incompletely) the only mechanism, missing 8 of 12 vitest-invoking script names (#7592-class gap,
// caught by a repo-wide audit after #7619 shipped).
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import semver from "semver";

const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

export function checkNodeVersion({
  nodeVersion = process.version,
  readFile = () => readFileSync(PACKAGE_JSON_PATH, "utf8"),
}: {
  nodeVersion?: string;
  readFile?: () => string;
} = {}): { ok: boolean; requiredRange: string | undefined; nodeVersion?: string } {
  const pkg = JSON.parse(readFile()) as { engines?: { node?: string } };
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
