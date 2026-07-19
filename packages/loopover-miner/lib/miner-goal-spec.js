import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { discoverMinerGoalSpecPath, parseMinerGoalSpecContent } from "@loopover/engine";
const MAX_MINER_GOAL_SPEC_BYTES = 32_768;
// Same convention as packages/loopover-mcp/bin/loopover-mcp.js's readCliTextFile: O_NOFOLLOW on open
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
        if (!stats.isFile() || stats.size > MAX_MINER_GOAL_SPEC_BYTES)
            return null;
        const buffer = Buffer.alloc(MAX_MINER_GOAL_SPEC_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const n = readImpl(fd, buffer, bytesRead, buffer.length - bytesRead, null);
            if (n === 0)
                break;
            bytesRead += n;
        }
        if (bytesRead > MAX_MINER_GOAL_SPEC_BYTES)
            return null;
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    finally {
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
 */
export function resolveMinerGoalSpec(repoPath, options = {}) {
    const existsImpl = options.existsSync ?? existsSync;
    const relativePath = discoverMinerGoalSpecPath((candidate) => existsImpl(join(repoPath, candidate)));
    if (!relativePath)
        return parseMinerGoalSpecContent(null);
    try {
        const content = readRegularUtf8File(join(repoPath, relativePath), options);
        return parseMinerGoalSpecContent(content);
    }
    catch {
        return parseMinerGoalSpecContent(null);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWluZXItZ29hbC1zcGVjLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWluZXItZ29hbC1zcGVjLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUUxRixPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ2pDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSx5QkFBeUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBR3hGLE1BQU0seUJBQXlCLEdBQUcsTUFBTSxDQUFDO0FBa0J6QyxxR0FBcUc7QUFDckcsaUhBQWlIO0FBQ2pILHdHQUF3RztBQUN4RywyRkFBMkY7QUFDM0YsU0FBUyxtQkFBbUIsQ0FBQyxJQUFZLEVBQUUsT0FBb0M7SUFDN0UsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLFFBQVEsSUFBSSxRQUFRLENBQUM7SUFDOUMsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLFNBQVMsSUFBSSxTQUFTLENBQUM7SUFDakQsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLFFBQVEsSUFBSSxRQUFRLENBQUM7SUFDOUMsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLFNBQVMsSUFBSSxTQUFTLENBQUM7SUFFakQsTUFBTSxFQUFFLEdBQUcsUUFBUSxDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsUUFBUSxHQUFHLFNBQVMsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUNyRSxJQUFJLENBQUM7UUFDSCxNQUFNLEtBQUssR0FBRyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDNUIsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsSUFBSSxLQUFLLENBQUMsSUFBSSxHQUFHLHlCQUF5QjtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQzNFLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMseUJBQXlCLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDM0QsSUFBSSxTQUFTLEdBQUcsQ0FBQyxDQUFDO1FBQ2xCLE9BQU8sU0FBUyxHQUFHLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNqQyxNQUFNLENBQUMsR0FBRyxRQUFRLENBQUMsRUFBRSxFQUFFLE1BQU0sRUFBRSxTQUFTLEVBQUUsTUFBTSxDQUFDLE1BQU0sR0FBRyxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFDM0UsSUFBSSxDQUFDLEtBQUssQ0FBQztnQkFBRSxNQUFNO1lBQ25CLFNBQVMsSUFBSSxDQUFDLENBQUM7UUFDakIsQ0FBQztRQUNELElBQUksU0FBUyxHQUFHLHlCQUF5QjtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ3ZELE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hELENBQUM7WUFBUyxDQUFDO1FBQ1QsU0FBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ2hCLENBQUM7QUFDSCxDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILE1BQU0sVUFBVSxvQkFBb0IsQ0FBQyxRQUFnQixFQUFFLFVBQXVDLEVBQUU7SUFDOUYsTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDLFVBQVUsSUFBSSxVQUFVLENBQUM7SUFFcEQsTUFBTSxZQUFZLEdBQUcseUJBQXlCLENBQUMsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNyRyxJQUFJLENBQUMsWUFBWTtRQUFFLE9BQU8seUJBQXlCLENBQUMsSUFBSSxDQUFDLENBQUM7SUFFMUQsSUFBSSxDQUFDO1FBQ0gsTUFBTSxPQUFPLEdBQUcsbUJBQW1CLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxZQUFZLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FBQztRQUMzRSxPQUFPLHlCQUF5QixDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxPQUFPLHlCQUF5QixDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3pDLENBQUM7QUFDSCxDQUFDIn0=