import { describe, expect, it } from "vitest";
import {
  atOrBefore,
  auditSnapshotForLeaks,
  buildFrozenRepoSnapshot,
  checksumSnapshot,
  freezeWorkUnit,
  FROZEN_REPO_SNAPSHOT_SCHEMA_VERSION,
  verifySnapshotChecksum,
  wasOpenAt,
  type FrozenRepoSnapshot,
  type RawWorkUnitRecord,
} from "../../scripts/frozen-repo-snapshot-core";
import { fetchAllPages, GITHUB_MAX_PAGES, GITHUB_PER_PAGE, missingArgs, parseArgs } from "../../scripts/frozen-repo-snapshot";

// #9259 (harness #9216, epic #8534): leak-proofing IS the deliverable. A snapshot that leaks future
// information still produces perfectly well-formed numbers downstream, so the failure is silent — which is
// why these invariants are asserted directly rather than trusted to the builder's structure.

const T = "2026-07-01T00:00:00.000Z";

function pr(number: number, overrides: Partial<RawWorkUnitRecord> = {}): RawWorkUnitRecord {
  return {
    workUnitId: `o/r#${number}`,
    number,
    kind: "pull_request",
    title: `PR ${number}`,
    body: "body",
    authorLogin: "contributor",
    createdAt: "2026-06-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

describe("atOrBefore — the single definition of 'visible at T' (#9259)", () => {
  it("is INCLUSIVE at T: what happened at the freeze instant is what the maintainer could see", () => {
    expect(atOrBefore(T, T)).toBe(true);
    expect(atOrBefore("2026-06-30T23:59:59.999Z", T)).toBe(true);
    expect(atOrBefore("2026-07-01T00:00:00.001Z", T)).toBe(false);
  });

  it("INVARIANT: an unreadable or absent timestamp is NOT visible — the fail-safe direction", () => {
    // A record whose date cannot be read might be from after T; admitting it risks a leak, excluding it
    // only costs context. The safe direction is the one that cannot inflate a score.
    for (const bad of [undefined, null, "", "yesterday", "2026-13-45T99:99:99Z"]) {
      expect(atOrBefore(bad, T)).toBe(false);
    }
    // An unreadable CUTOFF is equally fail-safe — nothing is visible against a cutoff nobody can parse.
    expect(atOrBefore("2026-06-01T00:00:00.000Z", "not a date")).toBe(false);
  });
});

describe("wasOpenAt (#9259)", () => {
  it("open at T means created at-or-before T and not yet closed at T", () => {
    expect(wasOpenAt(pr(1), T)).toBe(true);
    expect(wasOpenAt(pr(2, { closedAt: "2026-08-01T00:00:00.000Z" }), T)).toBe(true); // closed AFTER T
    expect(wasOpenAt(pr(3, { closedAt: "2026-06-15T00:00:00.000Z" }), T)).toBe(false); // already closed
    expect(wasOpenAt(pr(4, { closedAt: T }), T)).toBe(false); // closed exactly at T
    expect(wasOpenAt(pr(5, { createdAt: "2026-07-02T00:00:00.000Z" }), T)).toBe(false); // not created yet
  });

  it("an unreadable closedAt keeps the unit OPEN — that keeps a question in the task, never leaks an answer", () => {
    expect(wasOpenAt(pr(6, { closedAt: "sometime" }), T)).toBe(true);
  });
});

describe("freezeWorkUnit (#9259)", () => {
  it("REGRESSION: labels applied AFTER T are dropped; labels applied at-or-before T survive", () => {
    const frozen = freezeWorkUnit(
      pr(1, {
        labels: [
          { name: "before", appliedAt: "2026-06-10T00:00:00.000Z" },
          { name: "at-T", appliedAt: T },
          { name: "after", appliedAt: "2026-07-05T00:00:00.000Z" },
          { name: "unparseable", appliedAt: "whenever" },
        ],
      }),
      T,
    );
    expect(frozen.labels).toEqual(["at-T", "before"]);
  });

  it("carries label NAMES only — the application timestamps did their job and must not travel onward", () => {
    const frozen = freezeWorkUnit(pr(1, { labels: [{ name: "bug", appliedAt: "2026-06-10T00:00:00.000Z" }] }), T);
    expect(JSON.stringify(frozen)).not.toContain("2026-06-10");
    expect(frozen.labels).toEqual(["bug"]);
  });

  it("REGRESSION: the frozen unit carries NO outcome field — a snapshot holds the question, not the answer", () => {
    const frozen = freezeWorkUnit(pr(1, { closedAt: "2026-08-01T00:00:00.000Z" }), T);
    for (const forbidden of ["closedAt", "mergedAt", "state", "merged"]) {
      expect(forbidden in frozen).toBe(false);
    }
  });

  it("deduplicates and sorts labels and paths, so two reads in different orders canonicalize identically", () => {
    const a = freezeWorkUnit(
      pr(1, {
        labels: [
          { name: "b", appliedAt: "2026-06-02T00:00:00.000Z" },
          { name: "a", appliedAt: "2026-06-01T00:00:00.000Z" },
          { name: "a", appliedAt: "2026-06-03T00:00:00.000Z" },
        ],
        changedPaths: ["src/z.ts", "src/a.ts", "src/z.ts"],
      }),
      T,
    );
    expect(a.labels).toEqual(["a", "b"]);
    expect(a.changedPaths).toEqual(["src/a.ts", "src/z.ts"]);
    // Absent optional collections become empty arrays, never undefined — the shape is uniform.
    const bare = freezeWorkUnit(pr(2), T);
    expect(bare.labels).toEqual([]);
    expect(bare.changedPaths).toEqual([]);
  });
});

describe("buildFrozenRepoSnapshot — the leak-proofing invariants (#9259)", () => {
  const base = { repoFullName: "o/r", commitSha: "abc123", frozenAt: T };

  it("REGRESSION: a fixture full of post-T records produces a snapshot that provably excludes them", () => {
    const snapshot = buildFrozenRepoSnapshot({
      ...base,
      workUnits: [
        pr(1), // open at T — included
        pr(2, { createdAt: "2026-07-10T00:00:00.000Z" }), // opened AFTER T
        pr(3, { closedAt: "2026-06-20T00:00:00.000Z" }), // already resolved before T
        pr(4, { kind: "issue", createdAt: "2026-06-05T00:00:00.000Z" }), // open issue at T
        pr(5, { kind: "issue", createdAt: "2026-09-01T00:00:00.000Z" }), // issue opened AFTER T
      ],
      decisions: [
        { workUnitId: "o/r#1", action: "merge", reasonCode: "clean", decidedAt: "2026-06-25T00:00:00.000Z" },
        { workUnitId: "o/r#1", action: "close", reasonCode: "defect", decidedAt: "2026-07-20T00:00:00.000Z" }, // AFTER T
      ],
    });
    expect(snapshot.openPullRequests.map((unit) => unit.workUnitId)).toEqual(["o/r#1"]);
    expect(snapshot.openIssues.map((unit) => unit.workUnitId)).toEqual(["o/r#4"]);
    expect(snapshot.recentDecisions).toHaveLength(1);
    expect(snapshot.recentDecisions[0]?.decidedAt).toBe("2026-06-25T00:00:00.000Z");
    // Nothing from the future appears ANYWHERE in the serialized snapshot, by any route.
    const serialized = JSON.stringify(snapshot);
    for (const future of ["2026-07-10", "2026-09-01", "2026-07-20", "PR 2", "PR 5"]) {
      expect(serialized).not.toContain(future);
    }
    expect(auditSnapshotForLeaks(snapshot)).toEqual([]);
  });

  it("INVARIANT: two builds of the same snapshot produce an identical checksum, regardless of input order", () => {
    const units = [pr(3), pr(1), pr(2, { kind: "issue" })];
    const decisions = [
      { workUnitId: "o/r#3", action: "merge", reasonCode: "clean", decidedAt: "2026-06-20T00:00:00.000Z" },
      { workUnitId: "o/r#1", action: "close", reasonCode: "defect", decidedAt: "2026-06-10T00:00:00.000Z" },
    ];
    const first = buildFrozenRepoSnapshot({ ...base, workUnits: units, decisions });
    const shuffled = buildFrozenRepoSnapshot({ ...base, workUnits: [...units].reverse(), decisions: [...decisions].reverse() });
    expect(shuffled.snapshotChecksum).toBe(first.snapshotChecksum);
    expect(shuffled).toEqual(first);
    expect(verifySnapshotChecksum(first)).toBe(true);
  });

  it("INVARIANT: a snapshot built at T never differs based on WHEN the build ran", () => {
    // The builder reads no clock, so the only way this could fail is a hidden time dependency. Appending a
    // year of post-T history — the difference between building on the day and building much later — must
    // not move the checksum by one bit.
    const sameDay = buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1)], decisions: [] });
    const muchLater = buildFrozenRepoSnapshot({
      ...base,
      workUnits: [pr(1), pr(9, { createdAt: "2027-06-01T00:00:00.000Z" }), pr(10, { kind: "issue", createdAt: "2027-07-01T00:00:00.000Z" })],
      decisions: [{ workUnitId: "o/r#1", action: "merge", reasonCode: "clean", decidedAt: "2027-01-01T00:00:00.000Z" }],
    });
    expect(muchLater.snapshotChecksum).toBe(sameDay.snapshotChecksum);
  });

  it("REGRESSION: the eventual OUTCOME of an included unit never enters the snapshot", () => {
    // o/r#1 was merged three weeks after T. That is precisely what an agent is asked to predict, so a
    // snapshot carrying it would be an answer key rather than a benchmark.
    const snapshot = buildFrozenRepoSnapshot({
      ...base,
      workUnits: [pr(1, { closedAt: "2026-07-21T00:00:00.000Z" })],
      decisions: [],
    });
    expect(snapshot.openPullRequests).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("2026-07-21");
    expect(auditSnapshotForLeaks(snapshot)).toEqual([]);
  });

  it("a changed checksum follows any change to the content it commits to", () => {
    const one = buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1)], decisions: [] });
    for (const mutated of [
      buildFrozenRepoSnapshot({ ...base, commitSha: "different", workUnits: [pr(1)], decisions: [] }),
      buildFrozenRepoSnapshot({ ...base, frozenAt: "2026-07-02T00:00:00.000Z", workUnits: [pr(1)], decisions: [] }),
      buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1, { title: "changed" })], decisions: [] }),
      buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1), pr(2)], decisions: [] }),
    ]) {
      expect(mutated.snapshotChecksum).not.toBe(one.snapshotChecksum);
    }
  });

  it("an empty repo yields a well-formed, checksummed, empty snapshot rather than an error", () => {
    const snapshot = buildFrozenRepoSnapshot({ ...base, workUnits: [] });
    expect(snapshot).toMatchObject({
      schemaVersion: FROZEN_REPO_SNAPSHOT_SCHEMA_VERSION,
      openPullRequests: [],
      openIssues: [],
      recentDecisions: [],
    });
    expect(verifySnapshotChecksum(snapshot)).toBe(true);
  });

  it("repeated decisions for one work unit sort deterministically by time then action", () => {
    const decisions = [
      { workUnitId: "o/r#1", action: "merge", reasonCode: "b", decidedAt: "2026-06-10T00:00:00.000Z" },
      { workUnitId: "o/r#1", action: "close", reasonCode: "a", decidedAt: "2026-06-10T00:00:00.000Z" },
      { workUnitId: "o/r#1", action: "hold", reasonCode: "c", decidedAt: "2026-06-05T00:00:00.000Z" },
    ];
    const built = buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1)], decisions });
    expect(built.recentDecisions.map((d) => `${d.decidedAt}/${d.action}`)).toEqual([
      "2026-06-05T00:00:00.000Z/hold",
      "2026-06-10T00:00:00.000Z/close",
      "2026-06-10T00:00:00.000Z/merge",
    ]);
    // Reversed input, identical output — the tie-break is total, not arrival-dependent.
    expect(buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1)], decisions: [...decisions].reverse() })).toEqual(built);

    // The FULL comparator chain: differing work units sort first, then time, then action. Includes a pair
    // identical on all three keys, which must not reorder (and must not crash the sort).
    const across = [
      { workUnitId: "o/r#2", action: "merge", reasonCode: "x", decidedAt: "2026-06-01T00:00:00.000Z" },
      { workUnitId: "o/r#1", action: "merge", reasonCode: "x", decidedAt: "2026-06-09T00:00:00.000Z" },
      { workUnitId: "o/r#1", action: "merge", reasonCode: "y", decidedAt: "2026-06-09T00:00:00.000Z" },
      // A byte-for-byte DUPLICATE: every tie-break key ties, including the canonical fallback. It must
      // survive (a repeated read is not the builder's to deduplicate) and must not destabilize the order.
      { workUnitId: "o/r#1", action: "merge", reasonCode: "y", decidedAt: "2026-06-09T00:00:00.000Z" },
      { workUnitId: "o/r#1", action: "close", reasonCode: "z", decidedAt: "2026-06-02T00:00:00.000Z" },
    ];
    const ordered = buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1), pr(2)], decisions: across });
    expect(ordered.recentDecisions.map((d) => `${d.workUnitId}/${d.decidedAt.slice(8, 10)}/${d.action}/${d.reasonCode}`)).toEqual([
      "o/r#1/02/close/z",
      "o/r#1/09/merge/x",
      "o/r#1/09/merge/y",
      "o/r#1/09/merge/y",
      "o/r#2/01/merge/x",
    ]);
    expect(buildFrozenRepoSnapshot({ ...base, workUnits: [pr(1), pr(2)], decisions: [...across].reverse() }).snapshotChecksum)
      .toBe(ordered.snapshotChecksum);
  });
});

describe("verifySnapshotChecksum / auditSnapshotForLeaks (#9259)", () => {
  const built = buildFrozenRepoSnapshot({ repoFullName: "o/r", commitSha: "abc", frozenAt: T, workUnits: [pr(1)] });

  it("a tampered snapshot fails checksum verification", () => {
    expect(verifySnapshotChecksum({ ...built, commitSha: "tampered" })).toBe(false);
    expect(verifySnapshotChecksum({ ...built, snapshotChecksum: "0".repeat(64) })).toBe(false);
    // REGRESSION: passing the WHOLE snapshot (the natural re-verification call) must give the same digest
    // as passing the body — an earlier spread-based implementation silently folded the existing checksum
    // into its own preimage and returned a wrong answer with no error.
    expect(checksumSnapshot(built)).toBe(built.snapshotChecksum);
    const { snapshotChecksum: _drop, ...body } = built;
    expect(checksumSnapshot(body)).toBe(built.snapshotChecksum);
  });

  it("REGRESSION: the audit catches every leak shape a hand-built or deserialized snapshot could carry", () => {
    const futureUnit = { ...built.openPullRequests[0], workUnitId: "o/r#99", createdAt: "2027-01-01T00:00:00.000Z" };
    const outcomeUnit = { ...built.openPullRequests[0], closedAt: "2026-08-01T00:00:00.000Z" };
    const leaky: FrozenRepoSnapshot = {
      ...built,
      openPullRequests: [futureUnit as never, outcomeUnit as never],
      openIssues: [{ ...built.openPullRequests[0], workUnitId: "o/r#98", kind: "issue", createdAt: "2027-02-02T00:00:00.000Z" } as never],
      recentDecisions: [{ workUnitId: "o/r#1", action: "merge", reasonCode: "clean", decidedAt: "2027-03-03T00:00:00.000Z" }],
    };
    const leaks = auditSnapshotForLeaks(leaky);
    expect(leaks).toHaveLength(4);
    expect(leaks.some((leak) => leak.includes("o/r#99") && leak.includes("createdAt is after frozenAt"))).toBe(true);
    expect(leaks.some((leak) => leak.includes('carries outcome field "closedAt"'))).toBe(true);
    expect(leaks.some((leak) => leak.startsWith("openIssues/o/r#98"))).toBe(true);
    expect(leaks.some((leak) => leak.startsWith("recentDecisions/o/r#1"))).toBe(true);
  });
});

describe("frozen-repo-snapshot CLI arg handling (#9259)", () => {
  it("parses every flag, defaults --db and --remote, and names each missing required flag", () => {
    const full = parseArgs(["--repo", "o/r", "--sha", "abc", "--frozen-at", T, "--output", "s.json", "--remote", "--db", "other"]);
    expect(full).toEqual({ repo: "o/r", sha: "abc", frozenAt: T, output: "s.json", remote: true, db: "other" });
    expect(missingArgs(full)).toEqual([]);

    const bare = parseArgs([]);
    expect(bare).toMatchObject({ remote: false, db: "loopover" });
    // All four named at once, so a user fixes them in a single pass rather than one run per flag.
    expect(missingArgs(bare)).toEqual(["--repo", "--sha", "--frozen-at", "--output"]);
    expect(missingArgs(parseArgs(["--repo", "o/r", "--sha", "abc"]))).toEqual(["--frozen-at", "--output"]);
    // A trailing --db with no value keeps the default rather than storing undefined.
    expect(parseArgs(["--db"]).db).toBe("loopover");
    // An unrecognized flag is ignored rather than throwing.
    expect(parseArgs(["--nonsense", "x", "--repo", "o/r"]).repo).toBe("o/r");
  });
});

describe("fetchAllPages — the CLI's pagination (#9259)", () => {
  /** A fake list endpoint holding `total` records, paged the way GitHub pages. */
  function pagedSource(total: number): { read: (url: string) => Promise<number[]>; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      read: async (url: string) => {
        calls.push(url);
        const page = Number(new URL(url, "https://x.test").searchParams.get("page"));
        const start = (page - 1) * GITHUB_PER_PAGE;
        return Array.from({ length: Math.max(0, Math.min(GITHUB_PER_PAGE, total - start)) }, (_, index) => start + index);
      },
    };
  }

  const url = (page: number) => `https://api.github.com/list?per_page=${GITHUB_PER_PAGE}&page=${page}`;

  it("REGRESSION: reads EVERY page — a single per_page=100 request silently dropped older records", () => {
    // The defect this test exists for: 250 records used to come back as 100, producing a well-formed but
    // incomplete snapshot whose checksum depended on how much the reader happened to see.
    return (async () => {
      const source = pagedSource(250);
      const result = await fetchAllPages(url, source.read);
      expect(result.truncated).toBe(false);
      expect(result.items).toHaveLength(250);
      expect(result.items[0]).toBe(0);
      expect(result.items[249]).toBe(249);
      expect(source.calls).toHaveLength(3);
    })();
  });

  it("stops at the first SHORT page, and an exactly-full last page costs one extra empty read", async () => {
    const short = pagedSource(150);
    expect((await fetchAllPages(url, short.read)).items).toHaveLength(150);
    expect(short.calls).toHaveLength(2);
    // Exactly 200: pages 1 and 2 are both full, so page 3 confirms the end. One wasted request beats
    // guessing the end from a count the API does not promise.
    const exact = pagedSource(200);
    const result = await fetchAllPages(url, exact.read);
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(false);
    expect(exact.calls).toHaveLength(3);
  });

  it("an empty and a single-page source both read exactly once", async () => {
    for (const total of [0, 1, GITHUB_PER_PAGE - 1]) {
      const source = pagedSource(total);
      const result = await fetchAllPages(url, source.read);
      expect(result).toMatchObject({ truncated: false });
      expect(result.items).toHaveLength(total);
      expect(source.calls).toHaveLength(1);
    }
  });

  it("REGRESSION: hitting the page bound REPORTS truncation rather than returning a short list as complete", async () => {
    // Every page is full, so the loop never sees an end. The bound must surface as `truncated`, which the
    // CLI turns into a refusal to write — a snapshot nobody can reproduce is not worth publishing.
    const endless = { read: async () => Array.from({ length: GITHUB_PER_PAGE }, (_, index) => index) };
    const result = await fetchAllPages(url, endless.read, 3);
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(3 * GITHUB_PER_PAGE);
    // The real bound is generous enough that no honest repo reaches it.
    expect(GITHUB_MAX_PAGES * GITHUB_PER_PAGE).toBeGreaterThanOrEqual(20_000);
  });

  it("a read error propagates rather than being swallowed into a short, complete-looking list", async () => {
    const failing = async (url: string) => {
      if (url.includes("page=2")) throw new Error("GitHub 502");
      return Array.from({ length: GITHUB_PER_PAGE }, (_, index) => index);
    };
    await expect(fetchAllPages(url, failing)).rejects.toThrow("GitHub 502");
  });
});
