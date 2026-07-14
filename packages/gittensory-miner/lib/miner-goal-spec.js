import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { discoverMinerGoalSpecPath, parseMinerGoalSpecContent } from "@loopover/engine";

const MAX_MINER_GOAL_SPEC_BYTES = 32_768;

// Real local .gittensory-miner.yml resolver (#5132, Wave 3.5 follow-up). MinerGoalSpec's own discovery
// helper (discoverMinerGoalSpecPath, packages/gittensory-engine) is deliberately IO-free -- the caller
// injects the existence check. Unlike self-review-context.js/rejection-signal.js/ams-policy.js, which fetch
// their target repo's files live over raw.githubusercontent.com BEFORE any clone exists, this resolver reads
// the ALREADY-CLONED repo on disk (attempt-worktree.js's prepareAttemptWorktree runs first in the real
// attempt-cli.js flow) -- no extra network round trip needed for a file that's already sitting in the
// worktree.

// Same convention as packages/gittensory-mcp/bin/loopover-mcp.js's readCliTextFile: O_NOFOLLOW on open
// atomically rejects a symlinked path (no separate pre-open lstat -- that would be a check-then-open race, since
// a symlink can be swapped in between the lstat and the open). Bounds the READ itself, not just fstat's
// reported size, since a regular file can still grow between fstatSync and the read below.
function readRegularUtf8File(path, options) {
  const openImpl = options.openSync ?? openSync;
  const fstatImpl = options.fstatSync ?? fstatSync;
  const readImpl = options.readSync ?? readSync;
  const closeImpl = options.closeSync ?? closeSync;

  const fd = openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatImpl(fd);
    if (!stats.isFile() || stats.size > MAX_MINER_GOAL_SPEC_BYTES) return null;
    const buffer = Buffer.alloc(MAX_MINER_GOAL_SPEC_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const n = readImpl(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (n === 0) break;
      bytesRead += n;
    }
    if (bytesRead > MAX_MINER_GOAL_SPEC_BYTES) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeImpl(fd);
  }
}

/**
 * Resolve the real, parsed MinerGoalSpec for an already-cloned repo at `repoPath`, trying each
 * MINER_GOAL_SPEC_FILENAMES candidate in the documented discovery order. Never throws: a missing file, an
 * unreadable file, or malformed content all degrade to the tolerant parser's own absent/safe-default result.
 *
 * Injected filesystem operations receive the FULL joined path (same convention as `node:fs`'s own
 * functions), not a repoPath-relative candidate.
 *
 * @param {string} repoPath
 * @param {{ existsSync?: (path: string) => boolean, openSync?: (path: string, flags: number) => number, fstatSync?: (fd: number) => import("node:fs").Stats, readSync?: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number, closeSync?: (fd: number) => void }} [options]
 * @returns {import("@loopover/engine").ParsedMinerGoalSpec}
 */
export function resolveMinerGoalSpec(repoPath, options = {}) {
  const existsImpl = options.existsSync ?? existsSync;

  const relativePath = discoverMinerGoalSpecPath((candidate) => existsImpl(join(repoPath, candidate)));
  if (!relativePath) return parseMinerGoalSpecContent(null);

  try {
    const content = readRegularUtf8File(join(repoPath, relativePath), options);
    return parseMinerGoalSpecContent(content);
  } catch {
    return parseMinerGoalSpecContent(null);
  }
}
