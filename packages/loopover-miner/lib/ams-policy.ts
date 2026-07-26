import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AmsPolicySpec } from "@loopover/engine";
import { AMS_POLICY_SPEC_FILENAMES, DEFAULT_AMS_POLICY_SPEC, discoverAmsPolicySpecPath, parseAmsPolicySpecContent } from "@loopover/engine";
import { resolveLocalStoreDbPath } from "./local-store.js";

// Resolver for the operator-local AMS policy files (#5132, Wave 3.5 follow-up; discovery order #8863).
// AmsPolicySpec (ams-policy-spec.ts, engine package) is the type/parser surface; this module is the actual
// local read+resolve caller, probing {@link AMS_POLICY_SPEC_FILENAMES} inside the operator config directory.
//
// This is deliberately NOT the same resolution shape as self-review-context.js/rejection-signal.js, which
// read from the target repo: AmsPolicySpec's fields are the OPERATOR's own execution-risk policy, so an
// untrusted target repo must never get final say over them.

const AMS_POLICY_FILENAME = AMS_POLICY_SPEC_FILENAMES[0];

export type AmsPolicySource = "local" | "default";

export type ResolvedAmsPolicy = {
  spec: AmsPolicySpec;
  source: AmsPolicySource;
  warnings: string[];
};

/** JSON fields for a resolved policy, omitted entirely when there is nothing to surface (#8853). */
export function amsPolicyWarningJsonFields(
  resolved: { source: string; warnings: string[] },
): { amsPolicySource: string; amsPolicyWarnings: string[] } | Record<string, never> {
  if (resolved.warnings.length === 0) return {};
  return { amsPolicySource: resolved.source, amsPolicyWarnings: [...resolved.warnings] };
}

/** Human-readable lines matching discover-cli's `ai-policy warnings` / note phrasing (#8853). */
export function renderAmsPolicyWarnings(resolved: { source: string; warnings: string[] }): string[] {
  if (resolved.warnings.length === 0) return [];
  return [
    `ams-policy warnings: ${resolved.warnings.length}`,
    ...resolved.warnings.map((warning) => `  ${warning}`),
    `ams-policy source: ${resolved.source}`,
  ];
}

export type AmsPolicyOptions = {
  /** Accepted for forward/API compatibility with callers that pass a fetch override; unused today since this
   *  resolver never fetches (see the module doc comment above). */
  fetchImpl?: unknown;
  readFileSync?: (path: string, encoding: "utf8") => string;
  existsSync?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
};

type NormalizedAmsPolicyOptions = {
  readFileSync: (path: string, encoding: "utf8") => string;
  existsSync: (path: string) => boolean;
  env: Record<string, string | undefined>;
};

/** Resolve the operator's local AMS policy file path: explicit env var > `LOOPOVER_MINER_CONFIG_DIR` >
 *  `XDG_CONFIG_HOME`/`~/.config`, mirroring every other local-store path in this package. This is the
 *  canonical write path (the first {@link AMS_POLICY_SPEC_FILENAMES} entry); reads use the full discovery order. */
export function resolveAmsPolicyConfigPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(AMS_POLICY_FILENAME, "LOOPOVER_MINER_AMS_POLICY_PATH", env);
}

/** Operator config directory searched by {@link discoverAmsPolicySpecPath} when no explicit file path is set. */
export function resolveAmsPolicyConfigDir(env: Record<string, string | undefined> = process.env): string {
  const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
    ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return explicitConfigDir;

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "loopover-miner");
}

function normalizeOptions(options: AmsPolicyOptions = {}): NormalizedAmsPolicyOptions {
  return {
    readFileSync: options.readFileSync ?? readFileSync,
    existsSync: options.existsSync ?? existsSync,
    env: options.env ?? process.env,
  };
}

/** Read the operator's own local AMS policy file, if one exists in the documented discovery order. Never throws:
 *  an unreadable file is treated the same as an absent one, falling through to the next resolution layer. */
function readLocalAmsPolicyContent(resolved: NormalizedAmsPolicyOptions): string | null {
  const explicitPath = typeof resolved.env.LOOPOVER_MINER_AMS_POLICY_PATH === "string"
    ? resolved.env.LOOPOVER_MINER_AMS_POLICY_PATH.trim()
    : "";
  if (explicitPath) {
    if (!resolved.existsSync(explicitPath)) return null;
    try {
      return resolved.readFileSync(explicitPath, "utf8");
    } catch {
      return null;
    }
  }

  const configDir = resolveAmsPolicyConfigDir(resolved.env);
  const relativePath = discoverAmsPolicySpecPath((candidate) => resolved.existsSync(join(configDir, candidate)));
  if (!relativePath) return null;

  const path = join(configDir, relativePath);
  try {
    return resolved.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the real, effective AMS execution policy for one attempt: the operator's own local AMS policy file
 * when present in the documented {@link AMS_POLICY_SPEC_FILENAMES} discovery order (source: "local"), else the
 * engine's safe defaults (source: "default").
 * Never throws -- an unreadable/malformed local file degrades through the tolerant parser to the safe
 * defaults, same discipline as every other tolerant parser in this pipeline.
 *
 * `repoFullName` is accepted for API compatibility with callers that resolve policy per target repo, but the
 * resolver intentionally does not fetch or trust target-repository AMS policy content.
 */
export async function resolveAmsPolicy(
  repoFullName: string,
  options: AmsPolicyOptions = {},
): Promise<ResolvedAmsPolicy> {
  void repoFullName;
  const resolved = normalizeOptions(options);

  const localContent = readLocalAmsPolicyContent(resolved);
  if (localContent !== null) {
    const parsed = parseAmsPolicySpecContent(localContent);
    return { spec: parsed.spec, source: "local", warnings: parsed.warnings };
  }

  return { spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] };
}
