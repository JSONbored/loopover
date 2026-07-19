import type { Stats } from "node:fs";
import type { ParsedMinerGoalSpec } from "@loopover/engine";
export type ResolveMinerGoalSpecOptions = {
    existsSync?: (path: string) => boolean;
    openSync?: (path: string, flags: number) => number;
    fstatSync?: (fd: number) => Stats;
    readSync?: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
    closeSync?: (fd: number) => void;
};
/**
 * Resolve the real, parsed MinerGoalSpec for an already-cloned repo at `repoPath`, trying each
 * MINER_GOAL_SPEC_FILENAMES candidate in the documented discovery order. Never throws: a missing file, an
 * unreadable file, or malformed content all degrade to the tolerant parser's own absent/safe-default result.
 *
 * Injected filesystem operations receive the FULL joined path (same convention as `node:fs`'s own
 * functions), not a repoPath-relative candidate.
 */
export declare function resolveMinerGoalSpec(repoPath: string, options?: ResolveMinerGoalSpecOptions): ParsedMinerGoalSpec;
