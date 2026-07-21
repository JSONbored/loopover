import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Regression coverage for the #7175 SqliteDriver-seam rollout (#7282): the four genuinely non-transactional
// AMS local stores now route their CRUD through `openLocalStoreAdapter`'s `driver.query(sql, params)` instead
// of raw `db.prepare().get()/.all()/.run()`. The migration must be behavior-preserving, so each store's write
// path and read path must still round-trip data end to end through the seam. run-state.js / policy-doc-cache.js
// (already on the seam) proved the pattern; these assert it holds for the newly-migrated stores.

import { emptyContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile.js";
import { initContributionProfileCache } from "../../packages/loopover-miner/lib/contribution-profile-cache.js";
import { initPolicyVerdictCacheStore } from "../../packages/loopover-miner/lib/policy-verdict-cache.js";
import { initPredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger.js";
import { openReplaySnapshotStore } from "../../packages/loopover-miner/lib/replay-snapshot.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-seam-"));
  roots.push(root);
  return join(root, name);
}

function track<T extends { close(): void }>(store: T): T {
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteDriver seam rollout — non-transactional store round-trips (#7282)", () => {
  it("contribution-profile-cache: put writes through driver.query and get reads it back", () => {
    const store = track(initContributionProfileCache(tempPath("contribution-profile-cache.sqlite3")));
    const at = Date.parse("2026-07-18T00:00:00.000Z");
    const profile = emptyContributionProfile("acme/widgets", new Date(at).toISOString());

    // Miss before any write (SELECT via the seam returns no row).
    expect(store.get("acme/widgets", at)).toBeNull();

    const written = store.put(profile, at);
    expect(written).toEqual({ repoFullName: "acme/widgets", fetchedAt: new Date(at).toISOString() });

    // Fresh read within the TTL: same profile, not stale.
    const fresh = store.get("acme/widgets", at);
    expect(fresh).toMatchObject({ profile, stale: false });

    // The ON CONFLICT upsert path also round-trips: a second put overwrites the same key.
    const laterAt = at + 1000;
    store.put(profile, laterAt);
    expect(store.get("acme/widgets", laterAt)?.fetchedAt).toBe(new Date(laterAt).toISOString());
  });

  it("policy-verdict-cache: put persists the verdict and get returns it through the seam", () => {
    const store = track(initPolicyVerdictCacheStore(tempPath("policy-verdict-cache.sqlite3")));
    const verdict = { allowed: true, matchedPhrase: null, source: "AI-USAGE.md" } as const;

    expect(store.get("https://api.github.com|acme/widgets")).toBeNull();

    const written = store.put("https://api.github.com|acme/widgets", "AI-USAGE.md", 'W/"etag-1"', verdict);
    expect(written).toMatchObject({ repoScope: "https://api.github.com|acme/widgets", decisiveDoc: "AI-USAGE.md", etag: 'W/"etag-1"' });

    expect(store.get("https://api.github.com|acme/widgets")).toEqual({
      decisiveDoc: "AI-USAGE.md",
      etag: 'W/"etag-1"',
      verdict,
    });
  });

  it("prediction-ledger: append returns the row the INSERT wrote (lastInsertRowid path) and readPredictions reads it back", () => {
    const ledger = track(initPredictionLedger(tempPath("prediction-ledger.sqlite3")));

    const first = ledger.appendPrediction({
      repoFullName: "owner/repo",
      targetId: 42,
      conclusion: "failure",
      pack: "gittensor",
      readinessScore: 55,
      blockerCodes: ["missing_linked_issue"],
      engineVersion: "0.2.0",
    });
    // The write path returns lastInsertRowid through driver.query, used to re-read the just-inserted row.
    expect(first).toMatchObject({ id: 1, repoFullName: "owner/repo", targetId: 42, conclusion: "failure" });

    const second = ledger.appendPrediction({ repoFullName: "other/repo", targetId: 7, conclusion: "success", pack: "oss", engineVersion: "0.2.0" });
    expect(second.id).toBe(2);

    // Unfiltered read (SELECT * ... ORDER BY id) returns both in insertion order.
    expect(ledger.readPredictions().map((e) => e.id)).toEqual([1, 2]);
    // Filtered read (the parameterized SELECT branch) returns only the matching repo's rows.
    expect(ledger.readPredictions({ repoFullName: "owner/repo" }).map((e) => e.targetId)).toEqual([42]);
  });

  it("replay-snapshot: saveSnapshot writes through the seam and getSnapshot reads the identical bundle back", () => {
    const store = track(openReplaySnapshotStore(tempPath("replay-snapshot.sqlite3")));

    expect(store.getSnapshot("acme/widgets", "abc1234")).toBeNull();

    const saved = store.saveSnapshot({
      repoFullName: "acme/widgets",
      commitSha: "abc1234",
      worktreePath: "/tmp/wt/abc1234",
      targetDate: "2026-07-01T00:00:00.000Z",
      commits: [{ sha: "abc1234", date: "2026-07-01T00:00:00.000Z", subject: "root" }],
      tags: [{ name: "v1.0.0", date: "2026-07-01T00:00:00.000Z", targetSha: "abc1234" }],
      readme: { filename: "README.md", content: "# hi" },
    });
    expect(saved).toMatchObject({ repoFullName: "acme/widgets", commitSha: "abc1234" });

    const read = store.getSnapshot("acme/widgets", "abc1234");
    expect(read).toEqual(saved);
    // JSON-encoded columns survive the round-trip intact.
    expect(read?.commits).toEqual([{ sha: "abc1234", date: "2026-07-01T00:00:00.000Z", subject: "root" }]);
    expect(read?.readme).toEqual({ filename: "README.md", content: "# hi" });
  });
});
