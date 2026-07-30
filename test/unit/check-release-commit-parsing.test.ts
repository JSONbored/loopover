import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { findUnparseableCommits } from "../../scripts/check-release-commit-parsing";

// #9948: release-please DROPS a commit it cannot parse -- no version bump, no changelog entry -- and the
// job still reports success. These drive its ACTUAL parser, so they cannot drift from real behaviour.

const parser = async () => (await import("release-please/build/src/commit.js")).parseConventionalCommits;


describe("findUnparseableCommits (#9948)", () => {
  it("catches NESTED PARENTHESES in the body — the real production trigger", async () => {
    // The line that actually broke it, verbatim from the dropped commit.
    const message = "fix(miner): discover --dry-run must not create the ledger\n\n`existsSync(resolveEventLedgerDbPath(env))` when parsed.dryRun is true,";
    const dropped = await findUnparseableCommits([{ sha: "abc1234", message }], await parser());
    expect(dropped).toHaveLength(1);
  });

  it("is position-sensitive, which is exactly why a regex cannot express it", async () => {
    // The SAME nested-paren text parses fine when it sits further along the line -- the parser reports a
    // column ("unexpected token '(' at 3:37"). Any hand-written pattern would either miss the real failures
    // or flag these, which is the case for driving the actual parser instead of matching on shapes.
    const shifted = "fix(x): s\n\nGuard the call with `existsSync(resolveEventLedgerDbPath(env))` when dryRun is true.";
    expect(await findUnparseableCommits([{ sha: "a", message: shifted }], await parser())).toEqual([]);
  });

  it("catches nested parens WITHOUT backticks — the backticks are not what matters", async () => {
    const dropped = await findUnparseableCommits([{ sha: "abc", message: "fix(x): s\n\nfoo(bar(baz)) is the thing" }], await parser());
    expect(dropped).toHaveLength(1);
  });

  it("leaves ordinary single-level parens alone", async () => {
    // The counterweight: prose parens are everywhere in this repo's commit bodies. A guard that flagged
    // them would block the entire queue and get switched off.
    const dropped = await findUnparseableCommits([{ sha: "abc", message: "fix(x): s\n\nfoo(bar) is the thing, per RFC 2119 (a standard)." }], await parser());
    expect(dropped).toEqual([]);
  });

  it("does NOT flag a subject ending in two issue refs — which looks like the culprit and is not", async () => {
    // An earlier cut of this checker guarded exactly this shape. It would have caught nothing while
    // reading as protection, which is worse than no guard at all.
    const dropped = await findUnparseableCommits([{ sha: "abc", message: "fix(gate): never close a PR for missing visual evidence (#9881) (#9934)" }], await parser());
    expect(dropped).toEqual([]);
  });

  it("reports each dropped commit individually, not just a count mismatch", async () => {
    // parseConventionalCommits returns a SHORTER array rather than throwing, so a batch call hides which
    // commit was lost. Per-commit is the only way to name it.
    const good = { sha: "g1", message: "feat(x): fine" };
    const bad = { sha: "b1", message: "fix(x): s\n\nnested(call(here))" };
    const dropped = await findUnparseableCommits([good, bad, good], await parser());
    expect(dropped.map((c) => c.sha)).toEqual(["b1"]);
  });

  it("is empty for no commits at all", async () => {
    expect(await findUnparseableCommits([], await parser())).toEqual([]);
  });

  it("REGRESSION: the real dropped commit message from main still fails to parse", async () => {
    // Guards the premise itself. If a release-please upgrade ever fixes this parser, this test goes red and
    // tells us the guard can be relaxed -- rather than silently protecting against nothing.
    const message = readFileSync("test/fixtures/release-please-unparseable-commit.txt", "utf8");
    expect(await findUnparseableCommits([{ sha: "8b446978", message }], await parser())).toHaveLength(1);
  });
});
