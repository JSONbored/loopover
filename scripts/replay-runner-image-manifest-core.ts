// Pure core for the replay-runner image's reproducibility manifest (#9214, epic #8534). Attestation over an
// unpinned, irreproducible workload is theater -- the launch measurement inside an envelope must correspond
// to an image anyone can independently rebuild and check. This module defines that check as a DECLARED-INPUTS
// digest (Dockerfile + lockfile + pinned base image + the exact source tree the image copies in), not as a
// digest of the BUILT Docker image itself.
//
// That choice is deliberate and documented (see replay-runner/README.md's "What is and isn't reproducible"
// section): `npm ci` against a committed lockfile and `tsc` compilation are both fully deterministic given
// identical inputs, so a declared-inputs digest is a sound proxy for "this exact image, rebuilt, is this exact
// image" -- but the DOCKER IMAGE ID itself (`docker inspect --format '{{.Id}}'`) is not claimed reproducible
// here: layer metadata (file mtimes, ownership bits as recorded by different Docker/BuildKit versions) is a
// known source of non-determinism this manifest does not attempt to solve. Anyone can independently verify
// the declared inputs never drifted; verifying the exact built image ID matches too is a stronger, separate
// claim this repo does not make.
import { createHash } from "node:crypto";

export type ReplayRunnerImageManifest = {
  /** Bump when the digest's INPUT SET changes (a file added/removed from `sourceFiles`, or the hash algorithm
   *  changes) -- so an old manifest is never silently compared against a new definition of "the inputs". */
  schemaVersion: 1;
  /** The pinned base image reference, digest-qualified (`node:22-slim@sha256:...`) -- copied verbatim from the
   *  Dockerfile's `FROM` line, never re-derived, so a base-image bump is visible as a manifest diff. */
  baseImageRef: string;
  dockerfileSha256: string;
  packageLockSha256: string;
  /** Path -> sha256, sorted by path, of every source file the image's build stage copies in. A file added to
   *  the image without a matching entry here is exactly the drift this manifest exists to catch. */
  sourceFiles: Record<string, string>;
  /** Single sha256 over the canonicalized whole (see {@link buildReplayRunnerImageManifest}) -- the one value
   *  a third party compares to confirm nothing above drifted, without diffing every field by hand. */
  digest: string;
};

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Canonicalize the manifest's own comparable fields into deterministic JSON before hashing. `sourceFiles`
 *  is trusted to arrive PRE-SORTED -- {@link buildReplayRunnerImageManifest} (this function's only caller)
 *  already sorts it before calling in, so re-sorting here would be redundant, untestable defensive code (its
 *  "out of order" branch could never fire against the one real call site). The property-order stability this
 *  function provides is JSON.stringify's own guarantee for string-keyed objects, not a re-sort. */
function canonicalize(input: {
  baseImageRef: string;
  dockerfileSha256: string;
  packageLockSha256: string;
  sourceFiles: Record<string, string>;
}): string {
  return JSON.stringify({
    baseImageRef: input.baseImageRef,
    dockerfileSha256: input.dockerfileSha256,
    packageLockSha256: input.packageLockSha256,
    sourceFiles: input.sourceFiles,
  });
}

/**
 * Build the manifest from raw inputs: the Dockerfile's and lockfile's own text, the pinned base image
 * reference, and a map of every source-file path the image copies in to that file's own text. Pure -- no
 * filesystem reads here, so the CLI (which does the reads) stays the only IO-touching layer, and this stays
 * unit-testable without a real checkout.
 */
export function buildReplayRunnerImageManifest(input: {
  baseImageRef: string;
  dockerfileContent: string;
  packageLockContent: string;
  sourceFileContents: Record<string, string>;
}): ReplayRunnerImageManifest {
  // Two-way, not the three-way `a < b ? -1 : a > b ? 1 : 0` idiom sibling modules use (export-d1-core.ts's
  // canonicalizeRow, backtest-corpus-export-core.ts's checksumCases): Object.entries keys are always
  // distinct, so the "equal" arm those siblings carry can never fire here and would be untestable dead code.
  const sourceFiles = Object.fromEntries(
    Object.entries(input.sourceFileContents)
      .map(([path, content]) => [path, sha256(content)] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const dockerfileSha256 = sha256(input.dockerfileContent);
  const packageLockSha256 = sha256(input.packageLockContent);
  const digest = sha256(canonicalize({ baseImageRef: input.baseImageRef, dockerfileSha256, packageLockSha256, sourceFiles }));
  return { schemaVersion: 1, baseImageRef: input.baseImageRef, dockerfileSha256, packageLockSha256, sourceFiles, digest };
}

export type ManifestDriftResult =
  | { drifted: false }
  | { drifted: true; reasons: string[] };

/**
 * Compare a freshly-built manifest against the committed one. Reports EVERY differing field (base image,
 * Dockerfile, lockfile, each added/removed/changed source file) rather than only the terminal digest
 * mismatch, so a drift report tells a reviewer exactly what moved instead of just that something did.
 */
export function checkReplayRunnerImageManifestDrift(committed: ReplayRunnerImageManifest, fresh: ReplayRunnerImageManifest): ManifestDriftResult {
  const reasons: string[] = [];
  if (committed.schemaVersion !== fresh.schemaVersion) {
    reasons.push(`schemaVersion: committed ${committed.schemaVersion}, fresh ${fresh.schemaVersion}`);
  }
  if (committed.baseImageRef !== fresh.baseImageRef) {
    reasons.push(`baseImageRef: committed ${committed.baseImageRef}, fresh ${fresh.baseImageRef}`);
  }
  if (committed.dockerfileSha256 !== fresh.dockerfileSha256) {
    reasons.push(`Dockerfile changed: committed ${committed.dockerfileSha256}, fresh ${fresh.dockerfileSha256}`);
  }
  if (committed.packageLockSha256 !== fresh.packageLockSha256) {
    reasons.push(`package-lock.json changed: committed ${committed.packageLockSha256}, fresh ${fresh.packageLockSha256}`);
  }
  const committedPaths = new Set(Object.keys(committed.sourceFiles));
  const freshPaths = new Set(Object.keys(fresh.sourceFiles));
  for (const path of committedPaths) {
    if (!freshPaths.has(path)) reasons.push(`source file removed: ${path}`);
    else if (committed.sourceFiles[path] !== fresh.sourceFiles[path]) reasons.push(`source file changed: ${path}`);
  }
  for (const path of freshPaths) {
    if (!committedPaths.has(path)) reasons.push(`source file added: ${path}`);
  }
  return reasons.length === 0 ? { drifted: false } : { drifted: true, reasons };
}
