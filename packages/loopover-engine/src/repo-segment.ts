// Shared repo-segment path-safety guard (the #5831 -> #7525 -> #8350 fix family). The miner package's
// parsers share packages/loopover-miner/lib/repo-clone.ts's isValidRepoSegment, but this engine package
// must not import from the miner package (miner depends on engine, not the reverse), so the engine keeps
// its own single copy here: a segment must be entirely [A-Za-z0-9._-] and must not be a bare "." or ".."
// traversal segment.

export const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidRepoSegment(segment: string): boolean {
  return REPO_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..";
}
