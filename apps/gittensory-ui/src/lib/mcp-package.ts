import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api/request";

export const MCP_PACKAGE_NAME = "@jsonbored/gittensory-mcp";
export const MCP_PACKAGE_ENCODED_NAME = "@jsonbored%2fgittensory-mcp";
export const MCP_PACKAGE_REGISTRY_URL = `https://registry.npmjs.org/${MCP_PACKAGE_ENCODED_NAME}`;
export const MCP_PACKAGE_NPM_URL = `https://www.npmjs.com/package/${MCP_PACKAGE_NAME}`;
export const MCP_PACKAGE_KNOWN_LATEST_VERSION = "0.6.0";
export const MCP_MINIMUM_SUPPORTED_VERSION = "0.5.0";

export type NpmPackageMetadata = {
  "dist-tags": { latest?: string };
  time: Record<string, string>;
  versions: Record<string, unknown>;
};

export function useMcpPackageMetadata() {
  return useQuery({
    queryKey: ["npm", MCP_PACKAGE_NAME],
    queryFn: fetchMcpPackageMetadata,
    staleTime: 1000 * 60 * 30,
    retry: 1,
  });
}

export async function fetchMcpPackageMetadata(): Promise<NpmPackageMetadata> {
  const result = await apiFetch<NpmPackageMetadata>(MCP_PACKAGE_REGISTRY_URL, {
    label: "MCP package version",
    timeoutMs: 6000,
    silentStatus: true,
  });
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

export function getLatestMcpVersion(data: NpmPackageMetadata | undefined): string {
  const latest = data?.["dist-tags"].latest;
  return latest && isStableVersion(latest) ? latest : MCP_PACKAGE_KNOWN_LATEST_VERSION;
}

export function getMcpInstallCommand(version?: string): string {
  return `npm i -g ${MCP_PACKAGE_NAME}@${version && isStableVersion(version) ? version : "latest"}`;
}

export function getMcpNpxPackage(version?: string): string {
  return `${MCP_PACKAGE_NAME}@${version && isStableVersion(version) ? version : "latest"}`;
}

export function getRecentMcpVersions(data: NpmPackageMetadata | undefined, limit = 6): string[] {
  if (!data) return [MCP_PACKAGE_KNOWN_LATEST_VERSION];
  return Object.keys(data.versions)
    .filter((version) => isStableVersion(version) && data.time[version])
    .sort((left, right) => data.time[right].localeCompare(data.time[left]))
    .slice(0, limit);
}

export function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}
