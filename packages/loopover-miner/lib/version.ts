// Self-referencing package import (requires the "exports" map in this package's own package.json) --
// robust by construction to however this file is currently running, whether as the real source
// lib/version.ts (imported in-process by tests) or the compiled dist/lib/version.js (a real CLI
// invocation): resolution walks up from THIS file's own location through node_modules the same way an
// external "@loopover/miner/..." import would, landing on the one real package.json either way -- no
// relative-path arithmetic to break if this file ever moves again.
import ownPackageJson from "@loopover/miner/package.json" with { type: "json" };

/** Package.json semver at import time — the laptop npm-install default. */
export const MINER_PACKAGE_VERSION: string = ownPackageJson.version;

/** Resolved miner release id: `LOOPOVER_MINER_VERSION` wins when set (fleet Docker image builds). */
export function resolveMinerVersion(env: Record<string, string | undefined> = process.env): string {
  const override = typeof env.LOOPOVER_MINER_VERSION === "string" ? env.LOOPOVER_MINER_VERSION.trim() : "";
  return override || MINER_PACKAGE_VERSION;
}
