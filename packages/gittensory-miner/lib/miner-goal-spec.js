import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMinerGoalSpecPath, parseMinerGoalSpecContent } from "@jsonbored/gittensory-engine";

// Real local .gittensory-miner.yml resolver (#5132, Wave 3.5 follow-up). MinerGoalSpec's own discovery
// helper (discoverMinerGoalSpecPath, packages/gittensory-engine) is deliberately IO-free -- the caller
// injects the existence check. Unlike self-review-context.js/rejection-signal.js/ams-policy.js, which fetch
// their target repo's files live over raw.githubusercontent.com BEFORE any clone exists, this resolver reads
// the ALREADY-CLONED repo on disk (attempt-worktree.js's prepareAttemptWorktree runs first in the real
// attempt-cli.js flow) -- no extra network round trip needed for a file that's already sitting in the
// worktree.

/**
 * Resolve the real, parsed MinerGoalSpec for an already-cloned repo at `repoPath`, trying each
 * MINER_GOAL_SPEC_FILENAMES candidate in the documented discovery order. Never throws: a missing file, an
 * unreadable file, or malformed content all degrade to the tolerant parser's own absent/safe-default result.
 *
 * `options.existsSync`/`options.readFileSync`, when injected, always receive the FULL joined path (same
 * convention as `node:fs`'s own functions), not a repoPath-relative candidate.
 *
 * @param {string} repoPath
 * @param {{ existsSync?: (path: string) => boolean, readFileSync?: (path: string, encoding: "utf8") => string }} [options]
 * @returns {import("@jsonbored/gittensory-engine").ParsedMinerGoalSpec}
 */
export function resolveMinerGoalSpec(repoPath, options = {}) {
  const existsImpl = options.existsSync ?? existsSync;
  const readImpl = options.readFileSync ?? readFileSync;

  const relativePath = discoverMinerGoalSpecPath((candidate) => existsImpl(join(repoPath, candidate)));
  if (!relativePath) return parseMinerGoalSpecContent(null);

  try {
    const content = readImpl(join(repoPath, relativePath), "utf8");
    return parseMinerGoalSpecContent(content);
  } catch {
    return parseMinerGoalSpecContent(null);
  }
}
