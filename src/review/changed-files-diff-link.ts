/** GitHub PR Files-tab diff anchors for changed-files summary links (#2157). */

import { createHash } from "node:crypto";

const REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** PURE: SHA-256 hex of the bare repo-relative path — GitHub's `#diff-…` anchor on the Files tab. */
export function githubPrFileDiffAnchor(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  return createHash("sha256").update(trimmed, "utf8").digest("hex");
}

/** PURE: public-safe PR Files-tab URL for one changed file, or null when inputs cannot be anchored. */
export function githubPrFileDiffUrl(
  repoFullName: string,
  pullNumber: number,
  path: string,
): string | null {
  if (!REPO_FULL_NAME.test(repoFullName) || !Number.isInteger(pullNumber) || pullNumber <= 0) return null;
  const anchor = githubPrFileDiffAnchor(path);
  if (anchor === null) return null;
  return `https://github.com/${repoFullName}/pull/${pullNumber}/files#diff-${anchor}`;
}
