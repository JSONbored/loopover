const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "go.sum",
  // Classification-only (not in the parseable set below): Rust, PHP, and Bun lockfiles, matching the
  // lockfile inventory already recognized in src/review/rag.ts. Categorizing them keeps a Cargo/Composer/Bun
  // lockfile bump from being mistaken for a source change.
  "cargo.lock",
  "composer.lock",
  "bun.lockb",
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
