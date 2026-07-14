import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultRankedCandidatesStore,
  initRankedCandidatesStore,
  listRankedCandidates,
  resolveRankedCandidatesDbPath,
  saveRankedCandidates,
} from "../../packages/gittensory-miner/lib/ranked-candidates.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-ranked-candidates-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  closeDefaultRankedCandidatesStore();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fullCandidate = {
  repoFullName: "acme/widgets",
  issueNumber: 42,
  title: "Fix the flaky retry logic",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
  rankScore: 0.81,
  laneFit: 0.9,
  freshness: 0.7,
  potential: 0.85,
  feasibility: 0.6,
  dupRisk: 0.1,
};

describe("gittensory-miner ranked-candidates store (#4859 prerequisite)", () => {
  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolveRankedCandidatesDbPath({ LOOPOVER_MINER_RANKED_CANDIDATES_DB: "/custom/ranked.sqlite3" })).toBe(
      "/custom/ranked.sqlite3",
    );
    expect(resolveRankedCandidatesDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/ranked-candidates.sqlite3",
    );
    expect(resolveRankedCandidatesDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/loopover-miner/ranked-candidates.sqlite3",
    );
    expect(resolveRankedCandidatesDbPath({})).toMatch(/\/\.config\/loopover-miner\/ranked-candidates\.sqlite3$/);
  });

  it("creates the SQLite table on first use, with owner-only file permissions, and reads [] before any save", () => {
    const dbPath = join(tempRoot(), "nested", "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(statSync(dbPath).mode & 0o077).toBe(0);
      expect(store.listRankedCandidates()).toEqual([]);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'miner_ranked_candidates'")
          .get();
        expect(row).toEqual({ name: "miner_ranked_candidates" });
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it("round-trips a full candidate and sorts by rankScore descending", () => {
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      const lowerScore = { ...fullCandidate, issueNumber: 43, rankScore: 0.2 };
      const result = store.saveRankedCandidates([lowerScore, fullCandidate], Date.parse("2026-07-13T12:00:00.000Z"));
      expect(result).toEqual({ count: 2, rankedAt: "2026-07-13T12:00:00.000Z" });

      const rows = store.listRankedCandidates();
      expect(rows).toEqual([
        { ...fullCandidate, rankedAt: "2026-07-13T12:00:00.000Z" },
        { ...lowerScore, rankedAt: "2026-07-13T12:00:00.000Z" },
      ]);
    } finally {
      store.close();
    }
  });

  it("defaults missing rank-dimension fields to the same neutral values opportunity-ranker.js uses (0, dupRisk 1)", () => {
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      store.saveRankedCandidates(
        [{ repoFullName: "acme/widgets", issueNumber: 1, rankScore: 0.5 }],
        Date.parse("2026-07-13T12:00:00.000Z"),
      );
      const [row] = store.listRankedCandidates();
      expect(row).toEqual({
        repoFullName: "acme/widgets",
        issueNumber: 1,
        title: "",
        htmlUrl: null,
        rankScore: 0.5,
        laneFit: 0,
        freshness: 0,
        potential: 0,
        feasibility: 0,
        dupRisk: 1,
        rankedAt: "2026-07-13T12:00:00.000Z",
      });
    } finally {
      store.close();
    }
  });

  it("replaces the whole snapshot atomically -- a second save wipes the first, never accumulates", () => {
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      store.saveRankedCandidates([fullCandidate], Date.parse("2026-07-13T12:00:00.000Z"));
      expect(store.listRankedCandidates()).toHaveLength(1);

      const secondRun = { ...fullCandidate, issueNumber: 99, title: "A different issue" };
      store.saveRankedCandidates([secondRun], Date.parse("2026-07-13T13:00:00.000Z"));
      const rows = store.listRankedCandidates();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.issueNumber).toBe(99);
      expect(rows[0]?.rankedAt).toBe("2026-07-13T13:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("replacing with an empty array clears the snapshot entirely", () => {
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      store.saveRankedCandidates([fullCandidate], Date.parse("2026-07-13T12:00:00.000Z"));
      store.saveRankedCandidates([], Date.parse("2026-07-13T14:00:00.000Z"));
      expect(store.listRankedCandidates()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("a non-array candidates argument degrades to an empty save rather than throwing", () => {
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      // @ts-expect-error -- deliberately wrong shape to exercise the Array.isArray guard.
      const result = store.saveRankedCandidates(null, Date.parse("2026-07-13T12:00:00.000Z"));
      expect(result).toEqual({ count: 0, rankedAt: "2026-07-13T12:00:00.000Z" });
    } finally {
      store.close();
    }
  });

  it("rejects a candidate with an invalid repoFullName, missing/non-positive issueNumber, or non-finite rankScore", () => {
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      // @ts-expect-error -- a non-object array entry, to exercise normalizeCandidate's own guard directly.
      expect(() => store.saveRankedCandidates([null])).toThrow("invalid_ranked_candidate");
      // repoFullName entirely absent (non-string), the other side of the `typeof === "string"` ternary.
      // @ts-expect-error -- repoFullName deliberately omitted to exercise that guard directly.
      expect(() => store.saveRankedCandidates([{ issueNumber: 1, rankScore: 0.5 }])).toThrow(
        "invalid_ranked_candidate",
      );
      expect(() => store.saveRankedCandidates([{ ...fullCandidate, repoFullName: "not-a-repo" }])).toThrow(
        "invalid_ranked_candidate",
      );
      expect(() => store.saveRankedCandidates([{ ...fullCandidate, issueNumber: 0 }])).toThrow(
        "invalid_ranked_candidate",
      );
      expect(() => store.saveRankedCandidates([{ ...fullCandidate, issueNumber: 1.5 }])).toThrow(
        "invalid_ranked_candidate",
      );
      expect(() => store.saveRankedCandidates([{ ...fullCandidate, rankScore: Number.NaN }])).toThrow(
        "invalid_ranked_candidate",
      );
      // An invalid entry mid-array must abort the WHOLE save (no partial write), verified by the table staying
      // empty after a rejected call that had one valid entry ahead of the bad one.
      expect(() =>
        store.saveRankedCandidates([fullCandidate, { ...fullCandidate, issueNumber: -1 }]),
      ).toThrow("invalid_ranked_candidate");
      expect(store.listRankedCandidates()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back the whole transaction on a genuine SQL-level failure (a duplicate repo+issue within one save)", () => {
    // Both entries individually pass normalizeCandidate (nothing there checks for array-internal duplicates), so
    // this is the one realistic way to reach the PRIMARY KEY constraint -- and therefore replaceAll's own
    // BEGIN IMMEDIATE/COMMIT/ROLLBACK transaction wrapper, which nothing else in this file exercises.
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      store.saveRankedCandidates([fullCandidate], Date.parse("2026-07-13T12:00:00.000Z"));
      expect(store.listRankedCandidates()).toHaveLength(1);

      expect(() =>
        store.saveRankedCandidates(
          [{ ...fullCandidate, title: "first" }, { ...fullCandidate, title: "duplicate" }],
          Date.parse("2026-07-13T13:00:00.000Z"),
        ),
      ).toThrow();

      // The prior snapshot survives: the failed transaction's DELETE was rolled back along with its INSERTs, so
      // the store is neither left empty nor partially written -- exactly the pre-save state.
      const rows = store.listRankedCandidates();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rankedAt).toBe("2026-07-13T12:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("defaults nowMs to the real clock when not injected", () => {
    const dbPath = join(tempRoot(), "ranked-candidates.sqlite3");
    const store = initRankedCandidatesStore(dbPath);
    try {
      const before = Date.now();
      const result = store.saveRankedCandidates([fullCandidate]);
      const after = Date.now();
      const rankedAtMs = Date.parse(result.rankedAt);
      expect(rankedAtMs).toBeGreaterThanOrEqual(before);
      expect(rankedAtMs).toBeLessThanOrEqual(after);
    } finally {
      store.close();
    }
  });

  it("module-level convenience functions operate on the lazily-opened default store", () => {
    const root = tempRoot();
    vi.stubEnv("LOOPOVER_MINER_RANKED_CANDIDATES_DB", join(root, "ranked-candidates.sqlite3"));
    const result = saveRankedCandidates([fullCandidate], Date.parse("2026-07-13T12:00:00.000Z"));
    expect(result.count).toBe(1);
    expect(listRankedCandidates()).toEqual([{ ...fullCandidate, rankedAt: "2026-07-13T12:00:00.000Z" }]);
  });
});
