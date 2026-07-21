// Shared expected MCP versions for production smoke (#6293). Latest tracks packages/loopover-mcp
// package.json the same way src/services/mcp-compatibility.ts does; the minimum floor stays a
// deliberate constant (not every release raises the supported floor).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Matches `MINIMUM_SUPPORTED_MCP_VERSION` in src/services/mcp-compatibility.ts. */
export const MINIMUM_SUPPORTED_MCP_VERSION = "0.5.0";

export type ExpectedMcpVersions = {
  minimumSupportedVersion: string;
  latestRecommendedVersion: string;
};

export function expectedMcpVersions(mcpPackageJson: { version?: unknown } | null | undefined): ExpectedMcpVersions {
  const version = typeof mcpPackageJson?.version === "string" ? mcpPackageJson.version.trim() : "";
  if (!version) throw new Error("packages/loopover-mcp/package.json is missing a non-empty version");
  return {
    minimumSupportedVersion: MINIMUM_SUPPORTED_MCP_VERSION,
    latestRecommendedVersion: version,
  };
}

/** Load the MCP package.json next to this repo's scripts/ directory. */
export function loadMcpPackageJson(fromUrl: string = import.meta.url): { version: string; [key: string]: unknown } {
  const packagePath = join(dirname(fileURLToPath(fromUrl)), "../packages/loopover-mcp/package.json");
  return JSON.parse(readFileSync(packagePath, "utf8"));
}
