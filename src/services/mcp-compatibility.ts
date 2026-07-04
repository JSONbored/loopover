export const GITTENSORY_API_VERSION = "0.1.0";
export const GITTENSORY_MCP_PACKAGE_NAME = "@jsonbored/gittensory-mcp";
export const MINIMUM_SUPPORTED_MCP_VERSION = "0.5.0";
export const LATEST_RECOMMENDED_MCP_VERSION = "0.6.0";

export type McpCompatibilityStatus = "current" | "stale" | "incompatible" | "unknown";

export type CompatibilityWarning = {
  code: string;
  message: string;
};

export type BreakingChangeNotice = {
  version: string;
  summary: string;
  mitigation?: string;
};

export type McpCompatibilityMetadata = {
  status: "ok";
  service: "gittensory-api";
  apiVersion: string;
  mcp: {
    packageName: string;
    minimumSupportedVersion: string;
    latestRecommendedVersion: string;
    latestPackageVersion: string;
    supportedVersionRange: string;
    upgradeCommand: string;
    npxFallbackCommand: string;
  };
  compatibilityWarnings: CompatibilityWarning[];
  breakingChanges: BreakingChangeNotice[];
  generatedAt: string;
};

export function buildMcpCompatibilityMetadata(generatedAt: string): McpCompatibilityMetadata {
  return {
    status: "ok",
    service: "gittensory-api",
    apiVersion: GITTENSORY_API_VERSION,
    mcp: {
      packageName: GITTENSORY_MCP_PACKAGE_NAME,
      minimumSupportedVersion: MINIMUM_SUPPORTED_MCP_VERSION,
      latestRecommendedVersion: LATEST_RECOMMENDED_MCP_VERSION,
      latestPackageVersion: LATEST_RECOMMENDED_MCP_VERSION,
      supportedVersionRange: `>=${MINIMUM_SUPPORTED_MCP_VERSION}`,
      upgradeCommand: `npm install -g ${GITTENSORY_MCP_PACKAGE_NAME}@latest`,
      npxFallbackCommand: `npx ${GITTENSORY_MCP_PACKAGE_NAME}@latest <command>`,
    },
    compatibilityWarnings: [],
    breakingChanges: [],
    generatedAt,
  };
}

export function classifyMcpClientVersion(version: string | null | undefined): McpCompatibilityStatus {
  if (!version) return "unknown";
  const minimumComparison = compareMcpSemver(version, MINIMUM_SUPPORTED_MCP_VERSION);
  if (minimumComparison === null) return "unknown";
  if (minimumComparison < 0) return "incompatible";
  // The client semver already parsed for the minimum check, so this comparison cannot return null.
  const recommendedComparison = compareMcpSemver(version, LATEST_RECOMMENDED_MCP_VERSION)!;
  if (recommendedComparison < 0) return "stale";
  return "current";
}

function parseSemver(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compare two dot-separated prerelease strings per semver §11.4. A plain numeric `localeCompare` on the
 * whole string is wrong: it compares leading digit runs numerically and so ranks `2` above `1a`, whereas
 * semver compares identifier-by-identifier, where a purely numeric identifier always has LOWER precedence
 * than an alphanumeric one. Case-insensitive per-identifier compare is preserved intentionally (matching
 * the existing `RC.1` == `rc.1` behavior).
 */
function comparePrerelease(left: string, right: string): -1 | 0 | 1 {
  const leftIds = left.split(".");
  const rightIds = right.split(".");
  const max = Math.max(leftIds.length, rightIds.length);
  for (let index = 0; index < max; index += 1) {
    if (index >= leftIds.length) return -1; // fewer identifiers = lower precedence
    if (index >= rightIds.length) return 1;
    const a = leftIds[index]!;
    const b = rightIds[index]!;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1; // numeric identifier ranks below alphanumeric
    } else {
      const comparison = a.toLowerCase().localeCompare(b.toLowerCase());
      if (comparison !== 0) return comparison < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function compareMcpSemver(leftVersion: string, rightVersion: string): number | null {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}
