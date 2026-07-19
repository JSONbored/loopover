export declare function resolveNpmRegistryUrl(env?: Record<string, string | undefined>): string;
export declare function resolveUpgradeCommand(packageName?: string): string;
export declare function shouldSkipUpdateCheck(cliArgs: string[], env?: Record<string, string | undefined>): boolean;
export declare function compareSemver(a: string, b: string): -1 | 0 | 1 | null;
export declare function fetchLatestPackageVersion(input: {
    packageName: string;
    npmRegistryUrl: string;
    timeoutMs?: number;
}): Promise<string>;
export declare function maybePrintUpdateNudge(input: {
    packageName: string;
    packageVersion: string;
    npmRegistryUrl: string;
    upgradeCommand: string;
    timeoutMs?: number;
}): Promise<void>;
export declare function startUpdateCheck(cliArgs: string[], input: {
    packageName: string;
    packageVersion: string;
    upgradeCommand?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
}): Promise<void>;
export declare const updateCheckExitGraceMs = 250;
export declare function awaitOpportunisticUpdateCheck(updateCheck: Promise<void>, graceMs?: number): Promise<void>;
