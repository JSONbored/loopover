const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "go.sum",
]);

/** Lockfiles the drift analyzer can actually parse today — narrower than categorization. */
const PARSEABLE_LOCKFILE_NAMES = new Set(["package-lock.json", "yarn.lock", "poetry.lock"]);

/** Lockfile basenames are case-insensitive on common filesystems — normalize separators first. */
export function lockfileBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** Broad lockfile classification for scheduler/category gating (includes pnpm/go). */
export function isSupportedLockfile(path: string): boolean {
  return LOCKFILE_NAMES.has(lockfileBasename(path).toLowerCase());
}

/** Lockfiles extractLockfileChanges can parse — must stay aligned with parseLockfile(). */
export function isParseableLockfile(path: string): boolean {
  return PARSEABLE_LOCKFILE_NAMES.has(lockfileBasename(path).toLowerCase());
}
