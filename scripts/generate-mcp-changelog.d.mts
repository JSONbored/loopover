import type { McpReleaseCommit } from "./mcp-release-core.d.mts";

export function generateMcpChangelog(input?: {
  output?: string;
  version?: string;
  generatedAt?: string;
  baseTag?: string | null;
  dryRun?: boolean;
}): {
  output: string;
  version: string;
  baseTag: string | null;
  commits: McpReleaseCommit[];
  changelog: string;
};

export function readReleasePrepEntries(input: { baseTag: string | null; targetVersion: string }): McpReleaseCommit[];
export function dependencyChange(name: string, previousDependencies?: Record<string, string> | undefined, currentDependencies?: Record<string, string> | undefined): string | null;
export function readConstant(source: string | null, constantName: string): string | null;
