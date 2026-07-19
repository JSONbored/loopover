const defaultPackageName = "@loopover/miner";
const defaultNpmRegistryUrl = "https://registry.npmjs.org";
function isLocalRegistryHost(hostname) {
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    return (normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1" ||
        normalized === "[::1]");
}
export function resolveNpmRegistryUrl(env = process.env) {
    const raw = env.LOOPOVER_NPM_REGISTRY_URL?.trim();
    if (!raw)
        return defaultNpmRegistryUrl;
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return defaultNpmRegistryUrl;
    }
    if (url.username || url.password || url.search || url.hash || !url.hostname) {
        return defaultNpmRegistryUrl;
    }
    const local = isLocalRegistryHost(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
        return defaultNpmRegistryUrl;
    }
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
}
export function resolveUpgradeCommand(packageName = defaultPackageName) {
    return `npm install -g ${packageName}@latest`;
}
export function shouldSkipUpdateCheck(cliArgs, env = process.env) {
    if (/^(1|true|yes)$/i.test(env.LOOPOVER_MINER_NO_UPDATE_CHECK ?? ""))
        return true;
    return cliArgs.includes("--no-update-check");
}
function parseSemver(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? "").trim());
    if (!match)
        return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? null,
    };
}
// Numeric identifiers are compared as decimal strings, not via Number(), which loses precision beyond
// Number.MAX_SAFE_INTEGER (2^53-1): two distinct digit strings past that width can round to the SAME float,
// making Number(leftId) !== Number(rightId) wrongly report them as equal (mirrors the same fix already applied
// to compareMcpSemver's comparePrerelease in src/services/mcp-compatibility.ts, #3049). With no leading zeros
// (semver's own numeric-identifier rule), a longer digit string is the larger number, and equal-length strings
// compare lexicographically.
function comparePrerelease(a, b) {
    const left = a.split(".");
    const right = b.split(".");
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const leftId = left[index];
        const rightId = right[index];
        if (leftId === undefined)
            return -1;
        if (rightId === undefined)
            return 1;
        const leftNumeric = /^\d+$/.test(leftId);
        const rightNumeric = /^\d+$/.test(rightId);
        if (leftNumeric && rightNumeric) {
            if (leftId.length !== rightId.length)
                return leftId.length < rightId.length ? -1 : 1;
            if (leftId !== rightId)
                return leftId < rightId ? -1 : 1;
        }
        else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        }
        else if (leftId !== rightId) {
            return leftId < rightId ? -1 : 1;
        }
    }
    return 0;
}
export function compareSemver(a, b) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right)
        return null;
    for (const part of ["major", "minor", "patch"]) {
        if (left[part] !== right[part])
            return left[part] < right[part] ? -1 : 1;
    }
    if (left.prerelease === right.prerelease)
        return 0;
    if (left.prerelease === null)
        return 1;
    if (right.prerelease === null)
        return -1;
    return comparePrerelease(left.prerelease, right.prerelease);
}
export async function fetchLatestPackageVersion(input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000);
    const registrySlug = input.packageName.startsWith("@")
        ? input.packageName.replace("/", "%2F")
        : input.packageName;
    const registryPath = `${input.npmRegistryUrl}/${registrySlug}/latest`;
    try {
        const response = await fetch(registryPath, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        const version = payload && typeof payload === "object" && "version" in payload
            ? payload.version
            : undefined;
        if (!response.ok || typeof version !== "string")
            throw new Error("npm_latest_version_unavailable");
        return version;
    }
    finally {
        clearTimeout(timeout);
    }
}
// Non-blocking startup nudge: prints one upgrade line when local is behind npm latest.
// Mirrors packages/loopover-mcp/bin/loopover-mcp.js packageVersion/npmRegistryUrl/upgradeCommand (#2331).
export async function maybePrintUpdateNudge(input) {
    try {
        const latestVersion = await fetchLatestPackageVersion(input);
        const comparison = compareSemver(input.packageVersion, latestVersion);
        if (comparison !== null && comparison < 0) {
            process.stderr.write(`${input.upgradeCommand}\n`);
        }
    }
    catch {
        // Offline or unreachable registry — never block or fail the CLI.
    }
}
export function startUpdateCheck(cliArgs, input) {
    if (shouldSkipUpdateCheck(cliArgs, input.env))
        return Promise.resolve();
    return maybePrintUpdateNudge({
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        npmRegistryUrl: resolveNpmRegistryUrl(input.env),
        upgradeCommand: input.upgradeCommand ?? resolveUpgradeCommand(input.packageName),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
}
export const updateCheckExitGraceMs = 250;
// After command output is printed, give a fast registry response time to emit the nudge
// without waiting for the full lookup timeout on slow/offline registries.
export async function awaitOpportunisticUpdateCheck(updateCheck, graceMs = updateCheckExitGraceMs) {
    await Promise.race([
        updateCheck.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidXBkYXRlLWNoZWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidXBkYXRlLWNoZWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE1BQU0sa0JBQWtCLEdBQUcsaUJBQWlCLENBQUM7QUFDN0MsTUFBTSxxQkFBcUIsR0FBRyw0QkFBNEIsQ0FBQztBQVMzRCxTQUFTLG1CQUFtQixDQUFDLFFBQWdCO0lBQzNDLE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQzdELE9BQU8sQ0FDTCxVQUFVLEtBQUssV0FBVztRQUMxQixVQUFVLEtBQUssV0FBVztRQUMxQixVQUFVLEtBQUssS0FBSztRQUNwQixVQUFVLEtBQUssT0FBTyxDQUN2QixDQUFDO0FBQ0osQ0FBQztBQUVELE1BQU0sVUFBVSxxQkFBcUIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUN6RixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMseUJBQXlCLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDbEQsSUFBSSxDQUFDLEdBQUc7UUFBRSxPQUFPLHFCQUFxQixDQUFDO0lBRXZDLElBQUksR0FBUSxDQUFDO0lBQ2IsSUFBSSxDQUFDO1FBQ0gsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3JCLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxPQUFPLHFCQUFxQixDQUFDO0lBQy9CLENBQUM7SUFFRCxJQUFJLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLFFBQVEsSUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDNUUsT0FBTyxxQkFBcUIsQ0FBQztJQUMvQixDQUFDO0lBRUQsTUFBTSxLQUFLLEdBQUcsbUJBQW1CLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFD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