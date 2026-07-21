import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  buildOrbReleaseReport,
  buildOrbStableReleaseReport,
  compareSemver,
  inferReleaseType,
  isImageRelevantCommit,
  latestOrbTag,
  latestStableOrbTag,
  parseOrbBetaVersion,
  parseSemver,
  selectImageRelevantCommits,
} from "../../scripts/orb-release-core.js";

type TestCommit = { sha: string; subject: string; body?: string; files: string[] };

function commit(subject: string, files: string[], over: Partial<TestCommit> = {}): TestCommit {
  return { sha: subject.padEnd(40, "0").slice(0, 40), subject, files, ...over };
}

describe("ORB image-relevant commit detection", () => {
  it("includes a commit touching src/**", () => {
    expect(selectImageRelevantCommits([commit("fix(queue): handle a null author", ["src/queue/processors.ts"])])).toHaveLength(1);
  });

  it("includes a commit touching migrations/**", () => {
    expect(selectImageRelevantCommits([commit("feat(db): add a column", ["migrations/0130_add_column.sql"])])).toHaveLength(1);
  });

  it("includes a commit touching the Dockerfile or docker-compose.yml", () => {
    expect(selectImageRelevantCommits([commit("ci: bump base image", ["Dockerfile"])])).toHaveLength(1);
    expect(selectImageRelevantCommits([commit("ci: add a profile", ["docker-compose.yml"])])).toHaveLength(1);
  });

  it("excludes a UI-only commit", () => {
    expect(selectImageRelevantCommits([commit("feat(ui): add a button", ["apps/loopover-ui/src/routes/app.index.tsx"])])).toEqual([]);
  });

  it("excludes an MCP-package-only commit", () => {
    expect(selectImageRelevantCommits([commit("feat(mcp): add a tool", ["packages/loopover-mcp/src/index.ts"])])).toEqual([]);
  });

  it("excludes src/mcp/** even though it's under the generally-relevant src/ prefix", () => {
    expect(selectImageRelevantCommits([commit("feat(mcp): add a server tool", ["src/mcp/server.ts"])])).toEqual([]);
  });

  it("excludes a merge commit", () => {
    expect(selectImageRelevantCommits([commit("Merge pull request #1 from acme/branch", ["src/queue/processors.ts"])])).toEqual([]);
  });

  it("excludes a commit with no files (e.g. an empty/metadata-only commit)", () => {
    expect(selectImageRelevantCommits([commit("chore: bump", [])])).toEqual([]);
  });

  it("includes a mixed commit as long as AT LEAST ONE file is relevant and not excluded", () => {
    const mixed = commit("feat(review): add a finding and its UI badge", ["src/review/visual-findings.ts", "apps/loopover-ui/src/routes/app.index.tsx"]);
    expect(selectImageRelevantCommits([mixed])).toEqual([mixed]);
  });

  it("isImageRelevantCommit is the single-commit form of the same check", () => {
    expect(isImageRelevantCommit(commit("fix(queue): x", ["src/queue/processors.ts"]))).toBe(true);
    expect(isImageRelevantCommit(commit("feat(ui): x", ["apps/loopover-ui/src/x.tsx"]))).toBe(false);
  });
});

describe("semver helpers", () => {
  it("parseSemver parses a stable and a beta version", () => {
    expect(parseSemver("0.4.0")).toEqual({ major: 0, minor: 4, patch: 0, prerelease: null });
    expect(parseSemver("0.4.0-beta.3")).toEqual({ major: 0, minor: 4, patch: 0, prerelease: "beta.3" });
    expect(parseSemver("not-a-version")).toBeNull();
  });

  it("parseOrbBetaVersion extracts the beta number, or null for a non-beta prerelease/stable version", () => {
    expect(parseOrbBetaVersion("0.4.0-beta.7")?.betaNumber).toBe(7);
    expect(parseOrbBetaVersion("0.4.0")?.betaNumber).toBeNull();
    expect(parseOrbBetaVersion("0.4.0-rc.1")?.betaNumber).toBeNull();
    expect(parseOrbBetaVersion("garbage")).toBeNull();
  });

  it("compareSemver orders stable > beta, and beta.N numerically not lexicographically", () => {
    expect(compareSemver("0.4.0", "0.4.0-beta.9")).toBe(1);
    expect(compareSemver("0.4.0-beta.9", "0.4.0-beta.10")).toBe(-1); // numeric, not string, comparison
    expect(compareSemver("0.4.0", "0.4.0")).toBe(0);
    expect(compareSemver("bad", "0.4.0")).toBeNull();
  });

  it("bumpVersion bumps major/minor/patch and resets the lower components", () => {
    expect(bumpVersion("0.4.2", "patch")).toBe("0.4.3");
    expect(bumpVersion("0.4.2", "minor")).toBe("0.5.0");
    expect(bumpVersion("0.4.2", "major")).toBe("1.0.0");
  });

  it("latestStableOrbTag picks the highest tag with no prerelease suffix, ignoring betas", () => {
    const tags = ["orb-v0.1.0", "orb-v0.2.0", "orb-v0.3.0", "orb-v0.4.0-beta.1", "orb-v0.4.0-beta.5"];
    expect(latestStableOrbTag(tags)?.tag).toBe("orb-v0.3.0");
  });

  it("latestOrbTag picks the highest tag of any kind, beta included", () => {
    const tags = ["orb-v0.3.0", "orb-v0.4.0-beta.1", "orb-v0.4.0-beta.5"];
    expect(latestOrbTag(tags)?.tag).toBe("orb-v0.4.0-beta.5");
  });

  it("both tag helpers ignore non-orb-v tags and malformed versions", () => {
    expect(latestStableOrbTag(["mcp-v1.0.0", "orb-vgarbage"])).toBeNull();
    expect(latestOrbTag([])).toBeNull();
  });

  // #6294: a same-version beta must never outrank its stable promotion. A lexicographic sort puts
  // "orb-v1.2.0-beta.10" ahead of "orb-v1.2.0" (the beta suffix string-sorts after its own prefix), which
  // would pick a stale beta as check-orb-release-due.mjs's git-log boundary once a beta and its stable
  // promotion point at different commits. Beta tags of a shipped version live in the tag list forever, so
  // this stays reachable indefinitely.
  it("latestOrbTag ranks a stable tag ahead of its same-version betas, not lexicographically (#6294)", () => {
    const tags = ["orb-v1.2.0", "orb-v1.2.0-beta.1", "orb-v1.2.0-beta.10"];
    expect(latestOrbTag(tags)?.tag).toBe("orb-v1.2.0");
    // The lexicographic ordering this guards against would have returned the beta instead.
    expect([...tags].sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0]).toBe(
      "orb-v1.2.0-beta.10",
    );
    // A later stable still wins over an earlier version's betas.
    expect(latestOrbTag([...tags, "orb-v1.3.0"])?.tag).toBe("orb-v1.3.0");
    // With no stable promotion yet, the highest beta is still the right answer (numeric, not string, order).
    expect(latestOrbTag(["orb-v1.2.0-beta.1", "orb-v1.2.0-beta.10"])?.tag).toBe("orb-v1.2.0-beta.10");
  });
});

describe("buildOrbReleaseReport", () => {
  const noCommits = { sinceStable: [], sinceLastTag: [] };

  it("is not due when no image-relevant commits landed since the last tag", () => {
    const report = buildOrbReleaseReport({ tags: ["orb-v0.3.0", "orb-v0.4.0-beta.5"], manifestVersion: "0.4.0", commits: noCommits });
    expect(report.due).toBe(false);
    expect(report.targetVersion).toBe("0.4.0");
  });

  it("is due and proposes the next beta number for the SAME target version when only patch-level commits landed", () => {
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.3.0", "orb-v0.4.0-beta.5"],
      manifestVersion: "0.4.0",
      commits: { sinceStable: [commit("fix(queue): x", ["src/queue/processors.ts"])], sinceLastTag: [commit("fix(queue): x", ["src/queue/processors.ts"])] },
    });
    expect(report).toMatchObject({ due: true, targetVersion: "0.4.0", nextTag: "orb-v0.4.0-beta.6", manifestStale: false });
  });

  it("restarts the beta counter at 1 when the manifest has moved to a new target version since the last tag", () => {
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.3.0", "orb-v0.4.0-beta.5"],
      manifestVersion: "0.5.0", // maintainer bumped the manifest by hand
      commits: { sinceStable: [commit("feat(review): x", ["src/review/x.ts"])], sinceLastTag: [commit("chore: bump manifest", ["orb-manifest.json"])] },
    });
    expect(report.targetVersion).toBe("0.5.0");
    expect(report.nextTag).toBe("orb-v0.5.0-beta.1");
  });

  it("flags manifestStale when commits imply a bigger bump than the manifest currently declares, without overriding the manifest's own target", () => {
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.3.0"],
      manifestVersion: "0.3.1", // maintainer only expected a patch
      commits: { sinceStable: [commit("feat(review): a real new feature", ["src/review/x.ts"])], sinceLastTag: [commit("feat(review): a real new feature", ["src/review/x.ts"])] },
    });
    expect(report.inferredVersion).toBe("0.4.0"); // feat: implies minor, not the manifest's patch guess
    expect(report.manifestStale).toBe(true);
    expect(report.targetVersion).toBe("0.3.1"); // still the human-declared target -- never silently overridden
  });

  it("falls back to the inferred version when no manifest version is supplied", () => {
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.3.0"],
      manifestVersion: null,
      commits: { sinceStable: [commit("fix(queue): x", ["src/queue/processors.ts"])], sinceLastTag: [commit("fix(queue): x", ["src/queue/processors.ts"])] },
    });
    expect(report.manifestStale).toBe(false);
    expect(report.targetVersion).toBe("0.3.1");
    expect(report.nextTag).toBe("orb-v0.3.1-beta.1");
  });

  it("is not due when the only commits since the last tag are UI/MCP-only (excluded), even though commits exist", () => {
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.3.0", "orb-v0.4.0-beta.5"],
      manifestVersion: "0.4.0",
      commits: { sinceStable: [], sinceLastTag: [commit("feat(ui): x", ["apps/loopover-ui/src/x.tsx"])] },
    });
    expect(report.due).toBe(false);
  });

  it("handles a brand-new repo with zero stable tags yet (baseline 0.0.0)", () => {
    const report = buildOrbReleaseReport({
      tags: [],
      manifestVersion: "0.1.0",
      commits: { sinceStable: [commit("feat(review): first cut", ["src/review/x.ts"])], sinceLastTag: [commit("feat(review): first cut", ["src/review/x.ts"])] },
    });
    expect(report.latestStableTag).toBeNull();
    expect(report.latestTag).toBeNull();
    expect(report.nextTag).toBe("orb-v0.1.0-beta.1");
  });

  it("is not due once targetVersion's own STABLE tag already exists, even though new commits landed and the manifest wasn't bumped forward", () => {
    // orb-v0.4.0-beta.1..5 were cut leading up to the stable orb-v0.4.0 promotion; the manifest still says
    // "0.4.0" (the maintainer hasn't moved the target forward yet) and a new image-relevant commit lands.
    // Proposing another beta for 0.4.0 now would either collide with beta.1 (a tag that already exists from
    // before the promotion) or just be a nonsensical "beta of an already-shipped version".
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.3.0", "orb-v0.4.0-beta.1", "orb-v0.4.0-beta.5", "orb-v0.4.0"],
      manifestVersion: "0.4.0",
      commits: { sinceStable: [], sinceLastTag: [commit("fix(queue): x", ["src/queue/processors.ts"])] },
    });
    expect(report.due).toBe(false);
    expect(report.latestStableTag).toBe("orb-v0.4.0");
    expect(report.latestTag).toBe("orb-v0.4.0");
  });

  it("does not mistake the STABLE tag for a beta to continue counting from when the manifest is bumped forward again", () => {
    // Even with the manifest correctly bumped to a new target, latestOrbTag can still resolve to the prior
    // stable release (nothing has been tagged for the new target yet) -- the beta counter must restart at 1
    // from that stable tag, not read a betaNumber off it (it has none; parseOrbBetaVersion returns
    // betaNumber: null for a version with no prerelease suffix at all, not null itself).
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.4.0-beta.5", "orb-v0.4.0"],
      manifestVersion: "0.5.0",
      commits: { sinceStable: [commit("feat(review): x", ["src/review/x.ts"])], sinceLastTag: [commit("feat(review): x", ["src/review/x.ts"])] },
    });
    expect(report.due).toBe(true);
    expect(report.nextTag).toBe("orb-v0.5.0-beta.1");
  });

  it("also exposes the raw image-relevant commits since the last STABLE tag, independent of the beta-vs-any-tag commits field", () => {
    const relevant = commit("fix(queue): x", ["src/queue/processors.ts"]);
    const excluded = commit("feat(ui): x", ["apps/loopover-ui/src/x.tsx"]);
    const report = buildOrbReleaseReport({
      tags: ["orb-v0.3.0"],
      manifestVersion: "0.4.0",
      commits: { sinceStable: [relevant, excluded], sinceLastTag: [relevant] },
    });
    expect(report.commitsSinceStable).toEqual([relevant]);
  });
});

describe("inferReleaseType", () => {
  it("returns null for an empty commit list", () => {
    expect(inferReleaseType([])).toBeNull();
  });

  it("returns patch when no commit is a feat or breaking change", () => {
    expect(inferReleaseType([commit("fix(queue): x", ["src/queue/processors.ts"])])).toBe("patch");
  });

  it("returns minor when any commit is a feat", () => {
    expect(inferReleaseType([commit("fix(queue): x", ["src/x.ts"]), commit("feat(review): x", ["src/y.ts"])])).toBe("minor");
  });

  it("returns major when a commit subject has the `!` breaking marker, even ahead of a feat", () => {
    expect(inferReleaseType([commit("feat(review)!: x", ["src/x.ts"])])).toBe("major");
  });

  it("returns major when a commit body has a BREAKING CHANGE: footer, even without the `!` marker", () => {
    expect(inferReleaseType([commit("fix(review): x", ["src/x.ts"], { body: "fix(review): x\n\nBREAKING CHANGE: removes the old field" })])).toBe("major");
  });
});

describe("buildOrbStableReleaseReport", () => {
  it("is not due when there are no image-relevant commits since the last stable tag", () => {
    const report = buildOrbStableReleaseReport({ tags: ["orb-v0.3.0", "orb-v0.4.0-beta.27"], commitsSinceStable: [] });
    expect(report).toMatchObject({ due: false, stableVersion: "0.3.0", nextVersion: "0.3.0", releaseType: null });
  });

  it("is not due when the only commits since stable are UI/MCP-only (excluded)", () => {
    const report = buildOrbStableReleaseReport({
      tags: ["orb-v0.3.0"],
      commitsSinceStable: [commit("feat(ui): x", ["apps/loopover-ui/src/x.tsx"])],
    });
    expect(report.due).toBe(false);
  });

  it("proposes a patch bump when only fixes landed", () => {
    const report = buildOrbStableReleaseReport({
      tags: ["orb-v0.3.0"],
      commitsSinceStable: [commit("fix(queue): x", ["src/queue/processors.ts"])],
    });
    expect(report).toMatchObject({ due: true, nextVersion: "0.3.1", releaseType: "patch" });
  });

  it("proposes a minor bump when a feat landed", () => {
    const report = buildOrbStableReleaseReport({
      tags: ["orb-v0.3.0"],
      commitsSinceStable: [commit("fix(queue): x", ["src/x.ts"]), commit("feat(review): x", ["src/y.ts"])],
    });
    expect(report).toMatchObject({ due: true, nextVersion: "0.4.0", releaseType: "minor" });
  });

  it("proposes a major bump when a breaking change landed", () => {
    const report = buildOrbStableReleaseReport({
      tags: ["orb-v0.3.0"],
      commitsSinceStable: [commit("feat(review)!: x", ["src/x.ts"])],
    });
    expect(report).toMatchObject({ due: true, nextVersion: "1.0.0", releaseType: "major" });
  });

  it("handles a brand-new repo with zero stable tags yet (baseline 0.0.0)", () => {
    const report = buildOrbStableReleaseReport({ tags: [], commitsSinceStable: [commit("feat(review): first cut", ["src/review/x.ts"])] });
    expect(report.latestStableTag).toBeNull();
    expect(report.stableVersion).toBe("0.0.0");
    expect(report.nextVersion).toBe("0.1.0");
  });

  it("defaults commitsSinceStable to empty when omitted", () => {
    const report = buildOrbStableReleaseReport({ tags: ["orb-v0.3.0"] });
    expect(report).toMatchObject({ due: false, commits: [] });
  });
});
