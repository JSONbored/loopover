import { existsSync, readFileSync } from "node:fs";
import { AMS_POLICY_SPEC_FILENAMES, DEFAULT_AMS_POLICY_SPEC, parseAmsPolicySpecContent } from "@jsonbored/gittensory-engine";
import { resolveLocalStoreDbPath } from "./local-store.js";

// Real two-scope resolver for `.gittensory-ams.yml` (#5132, Wave 3.5 follow-up). AmsPolicySpec
// (ams-policy-spec.ts, engine package) is the type/parser surface; this module is the actual fetch+resolve
// caller, mirroring `.gittensory.yml`'s own established self-host precedent (src/selfhost/private-config.ts's
// `makeLocalManifestReader`): the operator's own local file, when present, FULLY REPLACES whatever the
// target repo's own file says -- never a field-by-field merge. The repo's file can only ever propose a
// more restrictive fallback for an operator who hasn't set their own local policy; repo-controlled content
// is clamped to the engine's safe deny-by-default policy before it becomes effective.
//
// This is deliberately NOT the same resolution shape as self-review-context.js/rejection-signal.js, which
// only ever read from the target repo: AmsPolicySpec's fields are the OPERATOR's own execution-risk policy
// (see ams-policy-spec.ts's own header for why a target repo must never get final say over that).

const AMS_POLICY_FILENAME = ".gittensory-ams.yml";
const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";

const SLOP_THRESHOLD_RANK = { clean: 0, low: 1, elevated: 2, high: 3 };

function clampNumberToDefault(value, fallback) {
  return Math.min(value, fallback);
}

function clampRepoAmsPolicySpec(spec, warnings) {
  const clamped = {
    submissionMode: spec.submissionMode === "observe" ? "observe" : DEFAULT_AMS_POLICY_SPEC.submissionMode,
    slopThreshold:
      SLOP_THRESHOLD_RANK[spec.slopThreshold] <= SLOP_THRESHOLD_RANK[DEFAULT_AMS_POLICY_SPEC.slopThreshold]
        ? spec.slopThreshold
        : DEFAULT_AMS_POLICY_SPEC.slopThreshold,
    capLimits: {
      budget: clampNumberToDefault(spec.capLimits.budget, DEFAULT_AMS_POLICY_SPEC.capLimits.budget),
      turns: clampNumberToDefault(spec.capLimits.turns, DEFAULT_AMS_POLICY_SPEC.capLimits.turns),
      elapsedMs: clampNumberToDefault(spec.capLimits.elapsedMs, DEFAULT_AMS_POLICY_SPEC.capLimits.elapsedMs),
    },
    convergenceThresholds: {
      maxConsecutiveFailures: clampNumberToDefault(
        spec.convergenceThresholds.maxConsecutiveFailures,
        DEFAULT_AMS_POLICY_SPEC.convergenceThresholds.maxConsecutiveFailures,
      ),
      maxReenqueues: clampNumberToDefault(spec.convergenceThresholds.maxReenqueues, DEFAULT_AMS_POLICY_SPEC.convergenceThresholds.maxReenqueues),
    },
    maxIterations: clampNumberToDefault(spec.maxIterations, DEFAULT_AMS_POLICY_SPEC.maxIterations),
    maxTurnsPerIteration: clampNumberToDefault(spec.maxTurnsPerIteration, DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration),
  };

  if (JSON.stringify(clamped) !== JSON.stringify(spec)) {
    warnings.push("Repo-controlled AmsPolicySpec cannot loosen the miner's safe default execution policy; permissive fields were clamped.");
  }

  return clamped;
}

/** Resolve the operator's local AMS policy file path: explicit env var > `GITTENSORY_MINER_CONFIG_DIR` >
 *  `XDG_CONFIG_HOME`/`~/.config`, mirroring every other local-store path in this package. */
export function resolveAmsPolicyConfigPath(env = process.env) {
  return resolveLocalStoreDbPath(AMS_POLICY_FILENAME, "GITTENSORY_MINER_AMS_POLICY_PATH", env);
}

function normalizeOptions(options = {}) {
  return {
    rawContentBaseUrl:
      typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
    fetchImpl: options.fetchImpl ?? fetch,
    readFileSync: options.readFileSync ?? readFileSync,
    existsSync: options.existsSync ?? existsSync,
    env: options.env ?? process.env,
  };
}

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
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

/** Fetch the target repo's own proposed `.gittensory-ams.yml`, trying each candidate path in order (first
 *  200 OK wins), mirroring self-review-context.js's `fetchManifestContent`. */
async function fetchRepoAmsPolicyContent(target, resolved) {
  for (const path of AMS_POLICY_SPEC_FILENAMES) {
    const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
    try {
      const response = await resolved.fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "gittensory-miner" } });
      if (response.ok) {
        const text = await response.text();
        if (typeof text === "string") return text;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

/**
 * Resolve the real, effective AMS execution policy for one attempt against `repoFullName`: the operator's
 * own local `.gittensory-ams.yml` when present (source: "local"), else the target repo's own proposed file
 * clamped to safe defaults when present (source: "repo"), else the engine's safe defaults (source: "default"). Never throws -- an
 * unreadable/malformed file at either layer degrades to the next layer or the safe defaults, same discipline
 * as every other tolerant parser in this pipeline.
 *
 * @param {string} repoFullName
 * @param {{
 *   rawContentBaseUrl?: string, fetchImpl?: import("./self-review-context.js").SelfReviewContextFetch,
 *   readFileSync?: (path: string, encoding: "utf8") => string, existsSync?: (path: string) => boolean,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 * @returns {Promise<{ spec: import("@jsonbored/gittensory-engine").AmsPolicySpec, source: "local"|"repo"|"default", warnings: string[] }>}
 */
export async function resolveAmsPolicy(repoFullName, options = {}) {
  const resolved = normalizeOptions(options);

  const localContent = readLocalAmsPolicyContent(resolved);
  if (localContent !== null) {
    const parsed = parseAmsPolicySpecContent(localContent);
    return { spec: parsed.spec, source: "local", warnings: parsed.warnings };
  }

  const target = parseRepoFullName(repoFullName);
  if (target) {
    const repoContent = await fetchRepoAmsPolicyContent(target, resolved);
    if (repoContent !== null) {
      const parsed = parseAmsPolicySpecContent(repoContent);
      return { spec: clampRepoAmsPolicySpec(parsed.spec, parsed.warnings), source: "repo", warnings: parsed.warnings };
    }
  }

  return { spec: DEFAULT_AMS_POLICY_SPEC, source: "default", warnings: [] };
}
