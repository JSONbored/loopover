import { describe, expect, it } from "vitest";

import { findUnparseableCommits, hasUnparseableTitle, UNPARSEABLE_TITLE } from "../../scripts/check-release-commit-titles";

// #9948: release-please DROPS a commit whose title it cannot parse -- no version bump, no changelog entry --
// and still reports success. Two shipped `fix(miner):` commits were invisible to the release when this was
// found, and the only evidence was buried in the job's logs.

describe("hasUnparseableTitle (#9948)", () => {
  it("flags the double-reference suffix release-please chokes on", () => {
    // The real observed failures, verbatim.
    expect(hasUnparseableTitle("fix(miner): discover --dry-run must not create/migrate/prune the event ledger (#9679) (#9905)")).toBe(true);
    expect(hasUnparseableTitle("fix(gate): never close a PR for visual evidence the pipeline cannot produce (#9881) (#9934)")).toBe(true);
    // No space between them is the same shape.
    expect(hasUnparseableTitle("fix(x): thing (#1)(#2)")).toBe(true);
  });

  it("leaves a NORMAL single-reference title alone", () => {
    // The counterweight. Almost every commit in this repo looks like this, so a false positive here would
    // block the whole queue and get the checker switched off within a day.
    expect(hasUnparseableTitle("fix(gate): never close a PR for visual evidence (#9934)")).toBe(false);
    expect(hasUnparseableTitle("feat(fairness): one-command public verifier + published methodology page (#9941)")).toBe(false);
    expect(hasUnparseableTitle("chore(release): cut engine v3.17.1")).toBe(false);
  });

  it("does not flag a reference that is not at the END of the title", () => {
    // `(#123)` mid-subject is prose, not a trailing reference pair; release-please parses these.
    expect(hasUnparseableTitle("fix(x): follow up to (#1) after the (#2) rework landed cleanly")).toBe(false);
    // ADJACENT refs that are not trailing. This is what makes the `$` anchor load-bearing: without it the
    // pattern matches here too, and a title release-please parses fine gets rejected.
    expect(hasUnparseableTitle("fix(x): supersedes (#1) (#2) with a single implementation")).toBe(false);
  });

  it("tolerates trailing whitespace, which a raw `git log` subject can carry", () => {
    expect(hasUnparseableTitle("fix(x): thing (#1) (#2)   ")).toBe(true);
  });

  it("exports the pattern as a global regex without leaking lastIndex between calls", () => {
    // A stateful /g regex would alternate true/false across identical inputs -- a genuinely confusing bug.
    expect(UNPARSEABLE_TITLE.flags).not.toContain("g");
    const title = "fix(x): thing (#1) (#2)";
    expect([hasUnparseableTitle(title), hasUnparseableTitle(title), hasUnparseableTitle(title)]).toEqual([true, true, true]);
  });
});

describe("findUnparseableCommits", () => {
  it("returns the offending `<sha> <subject>` lines and nothing else", () => {
    const lines = [
      "aaa1111 fix(miner): the event ledger (#9679) (#9905)",
      "bbb2222 feat(x): a perfectly normal commit (#9941)",
      "ccc3333 fix(gate): visual evidence (#9881) (#9934)",
    ];
    expect(findUnparseableCommits(lines)).toEqual(["aaa1111 fix(miner): the event ledger (#9679) (#9905)", "ccc3333 fix(gate): visual evidence (#9881) (#9934)"]);
  });

  it("is empty for a clean branch, and ignores blank lines", () => {
    expect(findUnparseableCommits(["aaa1111 feat(x): fine (#1)", "", "   "])).toEqual([]);
    expect(findUnparseableCommits([])).toEqual([]);
  });

  it("does not treat a SHA that happens to look like a reference as a subject", () => {
    // The split is on the first space; a subject with no space at all must not read as its own sha.
    expect(findUnparseableCommits(["aaa1111 chore: bump"])).toEqual([]);
  });
});
