/** Package.json semver at import time — the laptop npm-install default. */
export declare const MINER_PACKAGE_VERSION: string;
/** Resolved miner release id: `LOOPOVER_MINER_VERSION` wins when set (fleet Docker image builds). */
export declare function resolveMinerVersion(env?: Record<string, string | undefined>): string;
