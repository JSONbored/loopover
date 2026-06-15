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
  const prereleaseComparison = left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true, sensitivity: "base" });
  return prereleaseComparison === 0 ? 0 : prereleaseComparison < 0 ? -1 : 1;
}
