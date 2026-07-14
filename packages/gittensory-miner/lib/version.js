import ownPackageJson from "../package.json" with { type: "json" };

/** Package.json semver at import time — the laptop npm-install default. */
export const MINER_PACKAGE_VERSION = ownPackageJson.version;

/** Resolved miner release id: `LOOPOVER_MINER_VERSION` wins when set (fleet Docker image builds). */
export function resolveMinerVersion(env = process.env) {
  const override = typeof env.LOOPOVER_MINER_VERSION === "string" ? env.LOOPOVER_MINER_VERSION.trim() : "";
  return override || MINER_PACKAGE_VERSION;
}
