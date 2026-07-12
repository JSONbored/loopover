import type { AmsPolicySpec } from "@jsonbored/gittensory-engine";
export function resolveAmsPolicyConfigPath(env?: Record<string, string | undefined>): string;

export type AmsPolicySource = "local" | "default";

export type ResolvedAmsPolicy = {
  spec: AmsPolicySpec;
  source: AmsPolicySource;
  warnings: string[];
};

export function resolveAmsPolicy(
  repoFullName: string,
  options?: {
    fetchImpl?: unknown;
    readFileSync?: (path: string, encoding: "utf8") => string;
    existsSync?: (path: string) => boolean;
    env?: Record<string, string | undefined>;
  },
): Promise<ResolvedAmsPolicy>;
