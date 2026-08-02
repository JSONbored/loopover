import { describe, expect, it } from "vitest";

import {
  commitType,
  describeStranded,
  findStrandedCommits,
  hiddenCommitTypes,
  isBreaking,
  isPublishedFile,
  isVersionOnlyManifestBump,
  publishedSourcePrefixes,
  readConfig,
  type CommitUnderReview,
  type ReleasePleaseConfig,
} from "../../scripts/check-releasable-commit-types";

// #9937: the guard against a shipped-source change that release-please will never release.
//
// The real incident: `chore(deps): migrate recharts to v3` rewrote packages/loopover-ui-kit/src/components/
// chart.tsx and @loopover/ui-kit stayed on 1.3.0, because `chore` is `hidden: true` in changelog-sections and
// release-please filters hidden types out before it ever builds a release candidate ("No user facing commits
// found ... skipping"). Green CI, unreleased change, no signal anywhere.

const CONFIG: ReleasePleaseConfig = {
  packages: { "packages/loopover-ui-kit": {}, "packages/loopover-engine": {} },
  "changelog-sections": [
    { type: "feat", section: "Features" },
    { type: "fix", section: "Fixes" },
    { type: "deps", section: "Dependencies" },
    { type: "chore", section: "Chores", hidden: true },
    { type: "test", section: "Tests", hidden: true },
  ],
};

const commit = (over: Partial<CommitUnderReview> = {}): CommitUnderReview => ({
  sha: "a".repeat(40),
  subject: "chore(deps): migrate recharts to v3 across all three workspaces (#8610)",
  files: ["packages/loopover-ui-kit/src/components/chart.tsx"],
  ...over,
});

describe("hiddenCommitTypes", () => {
  it("reads the hidden set out of the config rather than hardcoding it", () => {
    expect(hiddenCommitTypes(CONFIG)).toEqual(new Set(["chore", "test"]));
  });

  it("treats a type absent from changelog-sections as NOT hidden", () => {
    // Absent means release-please's defaults apply; assuming hidden would fail commits that release fine.
    expect(hiddenCommitTypes(CONFIG).has("perf")).toBe(false);
    expect(hiddenCommitTypes({})).toEqual(new Set());
  });
});

describe("publishedSourcePrefixes", () => {
  it("covers each configured package's src/ and package.json", () => {
    expect(publishedSourcePrefixes(CONFIG)).toEqual([
      "packages/loopover-ui-kit/src/",
      "packages/loopover-ui-kit/package.json",
      "packages/loopover-engine/src/",
      "packages/loopover-engine/package.json",
    ]);
  });

  it("derives them from the config, so a newly configured package is covered automatically", () => {
    expect(publishedSourcePrefixes({ packages: { "packages/new-thing": {} } })).toContain("packages/new-thing/src/");
  });
});

describe("isPublishedFile", () => {
  it("excludes test and spec files in every extension the repo uses", () => {
    for (const file of ["a/chart.test.tsx", "a/x.test.ts", "a/y.spec.ts", "a/z.spec.tsx"]) {
      expect(isPublishedFile(file), file).toBe(false);
    }
  });

  it("keeps ordinary source, including files that merely mention test in the name", () => {
    for (const file of ["a/chart.tsx", "a/test-utils.ts", "a/latest.ts"]) {
      expect(isPublishedFile(file), file).toBe(true);
    }
  });
});

describe("commitType / isBreaking", () => {
  it("reads the type, with or without a scope", () => {
    expect(commitType("chore(deps): x")).toBe("chore");
    expect(commitType("fix: y")).toBe("fix");
    expect(commitType("FEAT(ui): z")).toBe("feat");
  });

  it("returns null for a non-conventional subject", () => {
    expect(commitType("just some text")).toBeNull();
    expect(commitType("")).toBeNull();
  });

  it("detects the breaking marker, which is user-facing whatever the type", () => {
    expect(isBreaking("chore(deps)!: drop node 20")).toBe(true);
    expect(isBreaking("chore(deps): bump")).toBe(false);
  });
});

describe("findStrandedCommits", () => {
  it("REGRESSION: flags the real recharts commit -- hidden type, published source", () => {
    const [stranded] = findStrandedCommits([commit()], CONFIG);
    expect(stranded).toMatchObject({ type: "chore", paths: ["packages/loopover-ui-kit/src/components/chart.tsx"] });
  });

  it("allows a user-facing type on the same files", () => {
    expect(findStrandedCommits([commit({ subject: "deps(ui-kit): migrate recharts to v3" })], CONFIG)).toEqual([]);
    expect(findStrandedCommits([commit({ subject: "fix(ui-kit): correct tooltip payload" })], CONFIG)).toEqual([]);
  });

  it("allows a hidden type that touches NO published source", () => {
    // The overwhelmingly common case, and the one that decides whether this guard is livable: chores against
    // scripts, workflows, tests and docs must stay silent.
    const files = ["scripts/thing.ts", ".github/workflows/ci.yml", "test/unit/x.test.ts", "README.md"];
    expect(findStrandedCommits([commit({ files })], CONFIG)).toEqual([]);
  });

  it("does not flag a package's own config or docs -- those are not what consumers install", () => {
    const files = ["packages/loopover-ui-kit/tsconfig.json", "packages/loopover-ui-kit/README.md"];
    expect(findStrandedCommits([commit({ files })], CONFIG)).toEqual([]);
  });

  it("REGRESSION: does not flag a co-located TEST file, even though it sits under src/", () => {
    // Caught by running this guard against the very commit that added it. Every package excludes
    // `src/**/*.test.*` from its build and none list tests in `files`, so a test is not published -- and
    // `test:` is a hidden type, making `test(pkg): add a test` the single most common hidden-type commit
    // there is. Flagging it would fire the guard on the ordinary case and get the guard switched off.
    const files = ["packages/loopover-ui-kit/src/components/chart.test.tsx"];
    expect(findStrandedCommits([commit({ subject: "test(ui-kit): cover chart", files })], CONFIG)).toEqual([]);
  });

  it("still flags the implementation file sitting beside that test", () => {
    const files = ["packages/loopover-ui-kit/src/components/chart.test.tsx", "packages/loopover-ui-kit/src/components/chart.tsx"];
    const [stranded] = findStrandedCommits([commit({ files })], CONFIG);
    // Only the shipped file is named -- listing the test too would send a reader to fix the wrong thing.
    expect(stranded?.paths).toEqual(["packages/loopover-ui-kit/src/components/chart.tsx"]);
  });

  it("DOES flag a package.json change, because a dependency range is part of what consumers resolve", () => {
    const files = ["packages/loopover-ui-kit/package.json"];
    expect(findStrandedCommits([commit({ files })], CONFIG)).toHaveLength(1);
  });

  it("allows a breaking hidden-type commit -- breaking is user-facing whatever the type", () => {
    expect(findStrandedCommits([commit({ subject: "chore(deps)!: drop react 18" })], CONFIG)).toEqual([]);
  });

  it("allows a commit carrying a Release-As footer, release-please's own override", () => {
    // Exempt because the commit has already answered this check's question, and this is the documented escape
    // hatch the failure message points at -- a guard whose stated remedy it then rejects is a broken guard.
    expect(findStrandedCommits([commit()], CONFIG, () => "Release-As: 1.3.1")).toEqual([]);
    expect(findStrandedCommits([commit()], CONFIG, () => "body\n\nRelease-As: 1.3.1\n")).toEqual([]);
  });

  it("does not mistake a mention of Release-As mid-sentence for the footer", () => {
    expect(findStrandedCommits([commit()], CONFIG, () => "we could use Release-As: here")).toHaveLength(1);
  });

  // #10286: release-please's own release commit is `chore(release):` and writes <pkg>/package.json, which
  // publishedSourcePrefixes matches by construction -- so before this, the guard fired on every release PR.
  it("REGRESSION: allows release-please's own release commit -- a version-only manifest bump", () => {
    const releaseCommit = commit({
      subject: "chore(release): cut ui-kit v1.7.0",
      files: ["packages/loopover-ui-kit/package.json"],
    });
    const diff = ['-  "version": "1.6.0",', '+  "version": "1.7.0",'].join("\n");
    expect(findStrandedCommits([releaseCommit], CONFIG, () => "", () => diff)).toEqual([]);
  });

  it("still flags a chore that changes a manifest BEYOND its version", () => {
    // The reason the exemption keys on the diff rather than the `chore(release):` subject: a dependency range
    // is part of what a consumer resolves, so stranding one is the very bug this guard exists for.
    const depEdit = commit({
      subject: "chore(release): cut ui-kit v1.7.0",
      files: ["packages/loopover-ui-kit/package.json"],
    });
    const diff = ['-  "version": "1.6.0",', '+  "version": "1.7.0",', '-    "recharts": "^3.9.0"', '+    "recharts": "^3.10.1"'].join("\n");
    expect(findStrandedCommits([depEdit], CONFIG, () => "", () => diff)).toHaveLength(1);
  });

  it("reports only the paths that are not version-only bumps when a commit mixes both", () => {
    const mixed = commit({
      subject: "chore(release): cut ui-kit v1.7.0",
      files: ["packages/loopover-ui-kit/package.json", "packages/loopover-ui-kit/src/components/chart.tsx"],
    });
    const diffOf = (_sha: string, file: string) =>
      file.endsWith("package.json") ? '-  "version": "1.6.0",\n+  "version": "1.7.0",' : "-old\n+new";
    const [stranded] = findStrandedCommits([mixed], CONFIG, () => "", diffOf);
    expect(stranded?.paths).toEqual(["packages/loopover-ui-kit/src/components/chart.tsx"]);
  });

  it("keeps flagging when no diff is available -- an unprovable exemption is not an exemption", () => {
    const releaseCommit = commit({
      subject: "chore(release): cut ui-kit v1.7.0",
      files: ["packages/loopover-ui-kit/package.json"],
    });
    expect(findStrandedCommits([releaseCommit], CONFIG)).toHaveLength(1);
  });
});

describe("isVersionOnlyManifestBump", () => {
  const bump = '-  "version": "1.6.0",\n+  "version": "1.7.0",';

  it("accepts a manifest whose only changed lines are the version field", () => {
    expect(isVersionOnlyManifestBump("packages/loopover-ui-kit/package.json", bump)).toBe(true);
  });

  it("ignores the diff header lines rather than counting them as changes", () => {
    const withHeader = ["--- a/packages/loopover-ui-kit/package.json", "+++ b/packages/loopover-ui-kit/package.json", bump].join("\n");
    expect(isVersionOnlyManifestBump("packages/loopover-ui-kit/package.json", withHeader)).toBe(true);
  });

  it("rejects a non-manifest file however its diff reads", () => {
    expect(isVersionOnlyManifestBump("packages/loopover-ui-kit/src/version.ts", bump)).toBe(false);
  });

  it("rejects an empty diff -- proves nothing, so it cannot exempt", () => {
    expect(isVersionOnlyManifestBump("packages/loopover-ui-kit/package.json", "")).toBe(false);
  });

  it("rejects a manifest diff carrying any non-version change", () => {
    expect(isVersionOnlyManifestBump("packages/loopover-ui-kit/package.json", `${bump}\n+  "sideEffects": false,`)).toBe(false);
  });

  it("ignores a non-conventional subject rather than guessing at its type", () => {
    expect(findStrandedCommits([commit({ subject: "merge branch main" })], CONFIG)).toEqual([]);
  });

  it("reports every offending commit, not just the first", () => {
    const second = commit({ sha: "b".repeat(40), subject: "test(engine): x", files: ["packages/loopover-engine/src/a.ts"] });
    expect(findStrandedCommits([commit(), second], CONFIG)).toHaveLength(2);
  });
});

describe("describeStranded", () => {
  it("names the commit, the paths, and BOTH documented ways out", () => {
    const message = describeStranded(findStrandedCommits([commit()], CONFIG), hiddenCommitTypes(CONFIG));
    expect(message).toContain("packages/loopover-ui-kit/src/components/chart.tsx");
    expect(message).toContain("deps:");
    expect(message).toContain("Release-As:");
    expect(message).toContain("chore, test");
  });
});

describe("readConfig", () => {
  it("INVARIANT: the repo's real config still marks chore hidden and lists ui-kit", () => {
    // Pins the two facts the guard depends on against the ACTUAL config, so unhiding `chore` or renaming a
    // package path cannot leave this check quietly asserting nothing.
    const config = readConfig();
    expect(hiddenCommitTypes(config).has("chore")).toBe(true);
    expect(publishedSourcePrefixes(config)).toContain("packages/loopover-ui-kit/src/");
  });

  it("REGRESSION: the historical recharts commit would have been caught by this guard", () => {
    // The whole point, stated against the real config rather than the fixture.
    const stranded = findStrandedCommits([commit()], readConfig());
    expect(stranded).toHaveLength(1);
  });
});
