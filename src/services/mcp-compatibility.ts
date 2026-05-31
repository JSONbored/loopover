export const GITTENSORY_API_VERSION = "0.1.0";
export const GITTENSORY_MCP_PACKAGE_NAME = "@jsonbored/gittensory-mcp";
export const MINIMUM_SUPPORTED_MCP_VERSION = "0.2.0";
export const LATEST_RECOMMENDED_MCP_VERSION = "0.3.0";

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
