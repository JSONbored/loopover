const defaultPackageName = "@loopover/miner";
const defaultNpmRegistryUrl = "https://registry.npmjs.org";

function isLocalRegistryHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function resolveNpmRegistryUrl(env = process.env) {
  const raw = env.GITTENSORY_NPM_REGISTRY_URL?.trim();
  if (!raw) return defaultNpmRegistryUrl;

  let url;
  try {
    url = new URL(raw);
  } catch {
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
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(
    String(version ?? "").trim(),
  );
  if (!match) return null;
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
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      if (leftId.length !== rightId.length) return leftId.length < rightId.length ? -1 : 1;
      if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftId !== rightId) {
      return leftId < rightId ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
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
    if (!response.ok || typeof payload.version !== "string")
      throw new Error("npm_latest_version_unavailable");
    return payload.version;
  } finally {
    clearTimeout(timeout);
  }
}

// Non-blocking startup nudge: prints one upgrade line when local is behind npm latest.
// Mirrors packages/gittensory-mcp/bin/loopover-mcp.js packageVersion/npmRegistryUrl/upgradeCommand (#2331).
export async function maybePrintUpdateNudge(input) {
  try {
    const latestVersion = await fetchLatestPackageVersion(input);
    const comparison = compareSemver(input.packageVersion, latestVersion);
    if (comparison !== null && comparison < 0) {
      process.stderr.write(`${input.upgradeCommand}\n`);
    }
  } catch {
    // Offline or unreachable registry — never block or fail the CLI.
  }
}

export function startUpdateCheck(cliArgs, input) {
  if (shouldSkipUpdateCheck(cliArgs, input.env)) return Promise.resolve();
  return maybePrintUpdateNudge({
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    npmRegistryUrl: resolveNpmRegistryUrl(input.env),
    upgradeCommand:
      input.upgradeCommand ?? resolveUpgradeCommand(input.packageName),
    timeoutMs: input.timeoutMs,
  });
}

export const updateCheckExitGraceMs = 250;

// After command output is printed, give a fast registry response time to emit the nudge
// without waiting for the full lookup timeout on slow/offline registries.
export async function awaitOpportunisticUpdateCheck(
  updateCheck,
  graceMs = updateCheckExitGraceMs,
) {
  await Promise.race([
    updateCheck.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ]);
}
