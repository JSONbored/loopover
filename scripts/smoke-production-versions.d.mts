export const MINIMUM_SUPPORTED_MCP_VERSION: string;

export type ExpectedMcpVersions = {
  minimumSupportedVersion: string;
  latestRecommendedVersion: string;
};

export function expectedMcpVersions(mcpPackageJson: { version?: unknown } | null | undefined): ExpectedMcpVersions;
export function loadMcpPackageJson(fromUrl?: string): { version: string; [key: string]: unknown };
