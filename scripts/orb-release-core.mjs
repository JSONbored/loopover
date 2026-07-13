// Pure logic for the ORB (self-host container image, ghcr.io/jsonbored/loopover-selfhost -- #4770: the
// pre-rename ghcr.io/jsonbored/gittensory-selfhost name remains a deprecated alias of the same build
// during the deprecation window tracked by #4777) automated beta
// channel. Deliberately independent of scripts/mcp-release-core.mjs (no shared imports/state) even though the
// shape mirrors it closely -- ORB and the MCP package are versioned, tagged, and published on separate
// schedules by separate automation, and keeping them decoupled means neither can accidentally regress the
// other's release path.
//
// Unlike MCP (whose packages/gittensory-mcp/package.json IS the version manifest, bumped by hand as part of a
// human release-prep PR), ORB has no npm manifest -- orb-manifest.json plays that role. The manifest's
// `version` is the maintainer's OWN stated intent ("we are working toward X.Y.Z"); this module only ever
// reads it, never proposes overwriting it automatically -- see `manifestStale` on the report. Promoting a
// beta to a stable, unsuffixed `orb-vX.Y.Z` tag is a separate, always-manual action.

const ORB_TAG_PREFIX = "orb-v";

// Paths that make the self-host container image itself (src/server.ts's bundle, its DB schema, and the
// image/deploy tooling around it) -- NOT the Cloudflare Worker-only surfaces (UI, browser extension) or the
// separately-versioned MCP/engine/miner packages, which have their own release automation.
const IMAGE_RELEVANT_PREFIXES = [
  "src/",
  "migrations/",
  "Dockerfile",
  "docker-compose.yml",
  "scripts/build-selfhost.mjs",
  "scripts/deploy-selfhost-image.sh",
  "scripts/deploy-selfhost-prebuilt.sh",
  "scripts/lib/selfhost-deploy-common.sh",
  "scripts/selfhost-post-update-check.sh",
  "scripts/validate-selfhost-sourcemap.mjs",
  "scripts/gen-selfhost-env-reference.mjs",
  "scripts/export-grafana-reporting-db.sh",
  ".github/workflows/release-selfhost.yml",
];

// Never itself a reason to cut a new image -- these are Worker-only, or genuinely orthogonal to what runs
// inside the self-host container.
const EXCLUDED_PREFIXES = [
  "apps/gittensory-ui/",
  "apps/gittensory-extension/",
  "packages/gittensory-mcp/",
  "packages/gittensory-miner/",
  "src/mcp/",
  "src/env.d.ts", // ambient Worker binding types only -- never reachable at self-host runtime
];

export function parseConventionalSubject(subject) {
  const trimmed = subject.trim();
  const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/.exec(trimmed);
  if (match?.groups) {
    return {
      type: match.groups.type,
      scope: match.groups.scope ?? null,
      breaking: Boolean(match.groups.breaking),
      description: match.groups.description.trim(),
      conventional: true,
    };
  }
  return { type: null, scope: null, breaking: false, description: trimmed, conventional: false };
}

export function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}

/** Parses ONLY the beta-channel shape this repo actually uses (`X.Y.Z-beta.N`) -- any other prerelease label
 *  (an `-rc.N`, a bare stable tag, or an unrecognized suffix) returns `betaNumber: null`, since it isn't a
 *  beta-channel tag this module's counter logic applies to. */
export function parseOrbBetaVersion(version) {
  const parsed = parseSemver(version);
  if (!parsed) return null;
  const betaMatch = /^beta\.(\d+)$/.exec(parsed.prerelease ?? "");
  return { ...parsed, betaNumber: betaMatch ? Number(betaMatch[1]) : null };
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const comparison = left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true, sensitivity: "base" });
  return comparison === 0 ? 0 : comparison < 0 ? -1 : 1;
}

export function bumpVersion(version, releaseType) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`Invalid semver version: ${version}`);
  if (releaseType === "major") return `${parsed.major + 1}.0.0`;
  if (releaseType === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** The highest STABLE (no prerelease suffix) orb-v tag -- the baseline every commit-scan/bump calculation
 *  measures from, regardless of how many beta snapshots have been cut since. */
export function latestStableOrbTag(tags) {
  return tags
    .map((tag) => ({ tag, version: tag.startsWith(ORB_TAG_PREFIX) ? tag.slice(ORB_TAG_PREFIX.length) : null }))
    .filter(({ version }) => version && parseSemver(version) !== null && parseSemver(version).prerelease === null)
    .sort((left, right) => compareSemver(right.version, left.version) ?? 0)[0] ?? null;
}

/** The highest orb-v tag of ANY kind (stable or beta) -- where the next commit-scan window starts, and what
 *  the next beta number counts up from when the target version hasn't changed. */
export function latestOrbTag(tags) {
  return tags
    .map((tag) => ({ tag, version: tag.startsWith(ORB_TAG_PREFIX) ? tag.slice(ORB_TAG_PREFIX.length) : null }))
    .filter(({ version }) => version && parseSemver(version))
    .sort((left, right) => compareSemver(right.version, left.version) ?? 0)[0] ?? null;
}

export function isImageRelevantCommit(commit) {
  const subject = (commit.subject ?? "").trim();
  if (!subject) return false;
  if (/^merge\b/i.test(subject)) return false;
  const files = commit.files ?? [];
  if (files.length === 0) return false;
  const relevantFiles = files.filter((file) => matchesAnyPrefix(file, IMAGE_RELEVANT_PREFIXES) && !matchesAnyPrefix(file, EXCLUDED_PREFIXES));
  return relevantFiles.length > 0;
}

export function selectImageRelevantCommits(commits) {
  return commits.filter((commit) => isImageRelevantCommit(commit));
}

function matchesAnyPrefix(file, prefixes) {
  return prefixes.some((prefix) => (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix));
}

export function inferReleaseType(commits) {
  if (commits.length === 0) return null;
  let type = "patch";
  for (const commit of commits) {
    const parsed = parseConventionalSubject(commit.subject ?? "");
    if (parsed.breaking || /BREAKING CHANGE:/i.test(commit.body ?? "")) return "major";
    if (parsed.type === "feat") type = "minor";
  }
  return type;
}

/**
 * Decide whether a new beta snapshot is due, and for which version. `manifestVersion` is the maintainer's
 * OWN stated target (orb-manifest.json), never overwritten by this function -- `manifestStale: true` only
 * FLAGS that the commits since the last stable tag imply a bigger bump than the manifest currently declares
 * (e.g. a `feat:` landed but the manifest still says a patch-level target), for a human to act on.
 */
export function buildOrbReleaseReport({ tags, manifestVersion, commits }) {
  const stableTag = latestStableOrbTag(tags);
  const anyTag = latestOrbTag(tags);
  const stableVersion = stableTag?.version ?? "0.0.0";

  const commitsSinceStable = selectImageRelevantCommits(commits.sinceStable ?? []);
  const inferredReleaseType = inferReleaseType(commitsSinceStable);
  const inferredVersion = inferredReleaseType ? bumpVersion(stableVersion, inferredReleaseType) : stableVersion;
  const manifestStale = Boolean(manifestVersion) && compareSemver(inferredVersion, manifestVersion) === 1;

  const targetVersion = manifestVersion || inferredVersion;
  const commitsSinceLastTag = selectImageRelevantCommits(commits.sinceLastTag ?? []);
  // A STABLE tag already exists for targetVersion (the manifest's own declared intent has already fully
  // shipped) -- cutting a beta for that exact version now would either collide with a pre-promotion beta
  // tag or silently mean "another beta of an already-released version," neither of which this pipeline is
  // meant to do. Nothing is due until a human moves the manifest's target forward (manifestStale above
  // already signals that a bigger bump than the manifest declares may be warranted).
  const targetAlreadyStable = stableTag !== null && stableTag.version === targetVersion;
  const due = commitsSinceLastTag.length > 0 && !targetAlreadyStable;

  // The next beta number: restart at 1 when the last tag isn't itself a beta OF targetVersion (a version
  // bump happened since, or -- critically -- the last tag targeting this version is its STABLE promotion,
  // not a beta at all); otherwise increment the last beta seen for this version. Checking betaNumber !==
  // null (not just matching major.minor.patch) is what keeps a stable tag from being misread as "the beta
  // to continue counting from."
  const anyTagBeta = anyTag ? parseOrbBetaVersion(anyTag.version) : null;
  const anyTagIsBetaOfTargetVersion =
    anyTagBeta !== null && anyTagBeta.betaNumber !== null && `${anyTagBeta.major}.${anyTagBeta.minor}.${anyTagBeta.patch}` === targetVersion;
  const nextBetaNumber = anyTagIsBetaOfTargetVersion ? anyTagBeta.betaNumber + 1 : 1;

  return {
    due,
    targetVersion,
    nextTag: `${ORB_TAG_PREFIX}${targetVersion}-beta.${nextBetaNumber}`,
    manifestVersion,
    manifestStale,
    inferredVersion,
    latestStableTag: stableTag?.tag ?? null,
    latestTag: anyTag?.tag ?? null,
    commits: commitsSinceLastTag,
    commitsSinceStable,
  };
}

/**
 * Decide whether a STABLE (non-beta) ORB release is due, and what its version would be -- the
 * `.github/workflows/orb-stable-release-pr.yml` counterpart to {@link buildOrbReleaseReport}'s beta-channel
 * logic. Unlike the beta report, this never reads `orb-manifest.json`'s declared target: the whole point of the
 * standing Release PR this powers is to PROPOSE the next stable version (inferred purely from conventional
 * commits since the last stable tag) for a maintainer to review by merging -- the PR diff writing that proposal
 * into orb-manifest.json is itself the human-reviewable gate, so there's nothing left here to compare it
 * against.
 */
export function buildOrbStableReleaseReport({ tags, commitsSinceStable }) {
  const stableTag = latestStableOrbTag(tags);
  const stableVersion = stableTag?.version ?? "0.0.0";

  const relevantCommits = selectImageRelevantCommits(commitsSinceStable ?? []);
  const releaseType = inferReleaseType(relevantCommits);
  const nextVersion = releaseType ? bumpVersion(stableVersion, releaseType) : stableVersion;
  const due = relevantCommits.length > 0;

  return {
    due,
    stableVersion,
    nextVersion,
    releaseType,
    latestStableTag: stableTag?.tag ?? null,
    commits: relevantCommits,
  };
}
