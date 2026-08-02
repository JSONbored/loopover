#!/usr/bin/env node
// A change to a released package's SHIPPED SOURCE, filed under a commit type release-please treats as
// invisible, never reaches npm (#9937).
//
// THE INCIDENT. `chore(deps): migrate recharts to v3 across all three workspaces (#8610)` rewrote
// `packages/loopover-ui-kit/src/components/chart.tsx` -- a real behavioural change to shipped code. It merged,
// CI was green, and @loopover/ui-kit stayed on 1.3.0 for weeks with that change sitting unreleased. Nothing
// was broken, nothing was red, and the only symptom was a drift issue whose checklist said "merge the
// release-please PR" for a PR that could never exist.
//
// WHY IT IS INVISIBLE. release-please decides whether a component has a release to cut BEFORE it decides how
// much to bump. Its own dry run says so:
//
//   ✔ Building candidate release pull request for path: packages/loopover-ui-kit
//   ✔ No user facing commits found since 0fa52ed838... - skipping
//
// "User facing" means the commit's type is not `hidden: true` in `changelog-sections`. `chore` is hidden here,
// so the commit is filtered out and no candidate release is built. Note that this is NOT the same question as
// how the versioning strategy would bump: asked directly, `DefaultVersioningStrategy` happily turns a `chore`
// into a patch (1.3.0 -> 1.3.1). It simply never gets asked. That gap between the two is precisely why this
// has to be checked rather than reasoned about.
//
// THE CONFIG IS THE SOURCE OF TRUTH, not a list here. Both the released package paths and the set of hidden
// types are read out of `release-please-config.json`, so adding a package, or unhiding a type, moves this
// check with it. Hardcoding either would make the guard drift from the release process it is guarding -- the
// same "compute the fact, don't remember it" bar the sibling `check-release-commit-parsing.ts` sets.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type ReleasePleaseConfig = {
  packages?: Record<string, unknown>;
  // `section` is carried so a fixture (or the real config) can be assigned to this type verbatim; only
  // `type` and `hidden` are read.
  "changelog-sections"?: { type?: unknown; hidden?: unknown; section?: unknown }[];
};

/** A commit reduced to what this check needs. */
export type CommitUnderReview = { sha: string; subject: string; files: readonly string[] };

export type StrandedCommit = { sha: string; subject: string; type: string; paths: string[] };

/** PURE. The commit types release-please filters out of "user facing commits", read from the config. A type
 *  absent from `changelog-sections` entirely is NOT hidden -- release-please's own default sections apply. */
export function hiddenCommitTypes(config: ReleasePleaseConfig): Set<string> {
  const hidden = new Set<string>();
  for (const section of config["changelog-sections"] ?? []) {
    if (section.hidden === true && typeof section.type === "string") hidden.add(section.type);
  }
  return hidden;
}

/** PURE. The source roots whose contents get published, one per configured package.
 *
 *  Deliberately `<pkg>/src/` rather than the whole package directory: a change to a package's README or its
 *  tsconfig does not alter what consumers install, so requiring a releasable type for those would be noise
 *  that trains people to reach for the override. `package.json` IS included -- a dependency range is part of
 *  what a consumer resolves. */
export function publishedSourcePrefixes(config: ReleasePleaseConfig): string[] {
  return Object.keys(config.packages ?? {}).flatMap((path) => {
    const base = path.replace(/\/+$/, "");
    return [`${base}/src/`, `${base}/package.json`];
  });
}

/** PURE. Test files live under `src/` in this repo but are excluded from every package's build (`tsconfig`
 *  `exclude`) and absent from its `files` allowlist, so they are NOT published. Without this, the single most
 *  common hidden-type commit there is -- `test(pkg): …` adding a co-located test -- would be flagged as a
 *  stranded release, and a guard that fires on the ordinary case is a guard that gets disabled. */
export function isPublishedFile(file: string): boolean {
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** PURE. The conventional-commit type of a subject line, or null when it has none. Only the type is needed,
 *  and only from the subject -- the body cannot change which section a commit lands in. */
export function commitType(subject: string): string | null {
  const match = /^([a-zA-Z]+)(?:\([^)]*\))?(!)?:/.exec(subject.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** PURE. A breaking change is always user-facing regardless of its type, so `chore!:` is never stranded. */
export function isBreaking(subject: string): boolean {
  return /^[a-zA-Z]+(?:\([^)]*\))?!:/.test(subject.trim());
}

/** PURE. Is this file's diff nothing but a `"version"` bump in a package manifest (#10286)?
 *
 *  release-please's own release commit is `chore(release): …` and its whole job is to write the new version
 *  into `<pkg>/package.json` -- a path {@link publishedSourcePrefixes} matches by construction. So without
 *  this, the guard fires on EVERY release PR: the one commit shape nobody hand-writes, that a maintainer
 *  therefore cannot fix by rewording, and whose flagged "would never reach npm" claim is exactly backwards
 *  (it is the commit that performs the release). That is precisely the ordinary-case firing this file's own
 *  `isPublishedFile` note warns gets a guard switched off.
 *
 *  Deliberately narrower than matching the `chore(release):` subject: a hand-written commit that borrows the
 *  subject while editing a dependency range or `exports` map is still a real stranded release, so the
 *  exemption is keyed on what the diff DID, not on what the subject claims. An empty diff (the default
 *  accessor, or a caller that cannot supply one) proves nothing and stays flagged. */
export function isVersionOnlyManifestBump(file: string, diff: string): boolean {
  if (!file.endsWith("/package.json")) return false;
  const changed = diff
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  if (changed.length === 0) return false;
  return changed.every((line) => /^[+-]\s*"version":\s*"[^"]*",?\s*$/.test(line));
}

/**
 * PURE. The commits that change published source under a type release-please will not release.
 *
 * A commit carrying a `Release-As:` footer is exempt: that is release-please's own documented mechanism for
 * forcing a version, so a commit using it has already answered this check's question.
 *
 * A path whose only change is a manifest version bump is dropped from consideration (#10286) -- see
 * {@link isVersionOnlyManifestBump}. A commit left with no other published-source path is release-please's
 * own release commit and is not stranded.
 */
export function findStrandedCommits(
  commits: readonly CommitUnderReview[],
  config: ReleasePleaseConfig,
  bodyOf: (sha: string) => string = () => "",
  diffOf: (sha: string, file: string) => string = () => "",
): StrandedCommit[] {
  const hidden = hiddenCommitTypes(config);
  const prefixes = publishedSourcePrefixes(config);
  const stranded: StrandedCommit[] = [];
  for (const commit of commits) {
    const type = commitType(commit.subject);
    if (type === null || !hidden.has(type) || isBreaking(commit.subject)) continue;
    const paths = commit.files.filter((file) => isPublishedFile(file) && prefixes.some((prefix) => file.startsWith(prefix)));
    if (paths.length === 0) continue;
    const releasable = paths.filter((file) => !isVersionOnlyManifestBump(file, diffOf(commit.sha, file)));
    if (releasable.length === 0) continue;
    if (/^\s*Release-As:/im.test(bodyOf(commit.sha))) continue;
    stranded.push({ sha: commit.sha, subject: commit.subject, type, paths: releasable });
  }
  return stranded;
}

/** PURE. The failure text. Names the offending paths and both ways out, because a guard whose message does not
 *  say what to do instead gets bypassed rather than satisfied. */
export function describeStranded(stranded: readonly StrandedCommit[], hidden: ReadonlySet<string>): string {
  const lines = [
    "",
    "These commits change published package source under a commit type release-please treats as invisible,",
    "so the change would merge green and then never reach npm:",
    "",
  ];
  for (const commit of stranded) {
    lines.push(`  ${commit.sha.slice(0, 8)} ${commit.subject}`);
    for (const path of commit.paths) lines.push(`      ${path}`);
  }
  lines.push(
    "",
    `Hidden types (from release-please-config.json changelog-sections): ${[...hidden].sort().join(", ")}`,
    "",
    "Fix by either:",
    "  • using a user-facing type -- `fix:` for a correction, `feat:` for an addition, `deps:` for a",
    "    dependency change (this repo already publishes a 'Dependencies' section for `deps`); or",
    "  • adding a `Release-As: <version>` footer, release-please's own mechanism for forcing a release when",
    "    the type genuinely is a chore.",
    "",
  );
  return lines.join("\n");
}

const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8" });

/** The commits this branch adds over its base, with the files each touched. Scoped to the branch rather than
 *  to all of history for the reason the sibling checker documents: `main` already carries commits that would
 *  fail, so an unscoped check would be permanently red and switched off within a day. */
export function commitsOnThisBranch(base: string): CommitUnderReview[] {
  const range = `${base}...HEAD`;
  const shas = git(["log", "--no-merges", "--format=%H", range]).split("\n").filter(Boolean);
  return shas.map((sha) => ({
    sha,
    subject: git(["log", "-1", "--format=%s", sha]).trim(),
    files: git(["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean),
  }));
}

export function readConfig(path = "release-please-config.json"): ReleasePleaseConfig {
  return JSON.parse(readFileSync(path, "utf8")) as ReleasePleaseConfig;
}

/* v8 ignore start -- the self-execution guard and its git/process plumbing; every pure branch is tested. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env["GITHUB_BASE_REF"] ? `origin/${process.env["GITHUB_BASE_REF"]}` : "origin/main";
  let commits: CommitUnderReview[] = [];
  try {
    commits = commitsOnThisBranch(base);
  } catch {
    process.stdout.write(`releasable-commit-types: cannot resolve ${base}; skipping.\n`);
    process.exit(0);
  }
  const config = readConfig();
  const stranded = findStrandedCommits(
    commits,
    config,
    (sha) => git(["log", "-1", "--format=%b", sha]),
    (sha, file) => git(["show", "--format=", "--unified=0", sha, "--", file]),
  );
  if (stranded.length === 0) {
    process.stdout.write(`releasable-commit-types: ${commits.length} commit(s) checked, none would be stranded.\n`);
    process.exit(0);
  }
  process.stderr.write(describeStranded(stranded, hiddenCommitTypes(config)));
  process.exit(1);
}
/* v8 ignore stop */
