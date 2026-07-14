import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_AMS_POLICY_SPEC, parseAmsPolicySpecContent } from "@loopover/engine";
import { resolveLocalStoreDbPath } from "./local-store.js";

// Resolver for the operator-local `.gittensory-ams.yml` (#5132, Wave 3.5 follow-up). AmsPolicySpec
// (ams-policy-spec.ts, engine package) is the type/parser surface; this module is the actual local
// read+resolve caller.
//
// This is deliberately NOT the same resolution shape as self-review-context.js/rejection-signal.js, which
// read from the target repo: AmsPolicySpec's fields are the OPERATOR's own execution-risk policy, so an
// untrusted target repo must never get final say over them.

const AMS_POLICY_FILENAME = ".gittensory-ams.yml";

/** Resolve the operator's local AMS policy file path: explicit env var > `LOOPOVER_MINER_CONFIG_DIR` >
 *  `XDG_CONFIG_HOME`/`~/.config`, mirroring every other local-store path in this package. */
export function resolveAmsPolicyConfigPath(env = process.env) {
  return resolveLocalStoreDbPath(AMS_POLICY_FILENAME, "LOOPOVER_MINER_AMS_POLICY_PATH", env);
}

function normalizeOptions(options = {}) {
  return {
    readFileSync: options.readFileSync ?? readFileSync,
    existsSync: options.existsSync ?? existsSync,
    env: options.env ?? process.env,
  };
}

/** Read the operator's own local `.gittensory-ams.yml`, if one exists. Never throws: an unreadable file is
 *  treated the same as an absent one, falling through to the next resolution layer. */
function readLocalAmsPolicyContent(resolved) {
  const path = resolveAmsPolicyConfigPath(resolved.env);
  if (!resolved.existsSync(path)) return null;
  try {
    return resolved.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the real, effective AMS execution policy for one attempt: the operator's own local
 * `.gittensory-ams.yml` when present (source: "local"), else the engine's safe defaults (source: "default").
 * Never throws -- an unreadable/malformed local file degrades through the tolerant parser to the safe
 * defaults, same discipline as every other tolerant parser in this pipeline.
 *
 * `repoFullName` is accepted for API compatibility with callers that resolve policy per target repo, but the
 * resolver intentionally does not fetch or trust target-repository AMS policy content.
 *
 * @param {string} repoFullName
 * @param {{
 *   readFileSync?: (path: string, encoding: "utf8") => string, existsSync?: (path: string) => boolean,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 * @returns {Promise<{ spec: import("@loopover/engine").AmsPolicySpec, source: "local"|"default", warnings: string[] }>}
 */
export async function resolveAmsPolicy(repoFullName, options = {}) {
  void repoFullName;
  const resolved = normalizeOptions(options);

  const localContent = readLocalAmsPolicyContent(resolved);
  if (localContent !== null) {
    const parsed = parseAmsPolicySpecContent(localContent);
    return { spec: parsed.spec, source: "local", warnings: parsed.warnings };
  }

  return { spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] };
}
