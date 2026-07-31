import { describe, expect, it } from "vitest";

import { checkStatsParity } from "../../packages/loopover-mcp/lib/verify-public-claims";
import { getPublicStats } from "../../src/review/public-stats";
import { loadReviewParityRollups } from "../../src/review/review-parity-rollups";
import { createTestEnv } from "../helpers/d1";

// #9971 (follow-up to #9963): the CROSS-SURFACE invariant, asserted rather than described.
//
// #9963 was an Orb publishing `totals.handled: 0` in the same payload as `reviewParity.verdicts: 2123`, both
// derived from the same ledger. #9967 fixed the aggregate and tested it thoroughly -- but per-surface. That is
// the exact blind spot the defect lived in, and the verifier's own source names it:
//
//   "the two are computed by different code over the same ledger, which is the divergence no amount of
//    per-surface testing catches, because each surface is individually self-consistent."
//
// Both halves were individually correct and individually green while production served the contradiction.
// `getPublicStats` and `loadReviewParityRollups` are still separate reads with separate gating, so nothing
// stops the next change to either from reintroducing the disagreement -- unless something builds BOTH from one
// ledger and compares them, which is what this file does.
//
// The comparison runs the verifier's OWN `checkStatsParity` rather than restating its rule. That function is
// what printed the original FAIL against the Orb; asserting through it means this test cannot drift from the
// tool that decides whether production is publishing a contradiction, which a hand-written `>=` could.
const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const REPO = "JSONbored/loopover";

/** Insert one ledger verdict. Direct SQL rather than `persistDecisionRecord`: this exercises a READ, and going
 *  through the writer would drag in digesting and the hash-chain append without making the row any more real. */
async function seedVerdict(env: Env, pull: number, headSha = `sha${pull}`): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `record:${REPO}#${pull}@${headSha}`,
      REPO,
      pull,
      headSha,
      "merge",
      "gate_pass",
      "d".repeat(64),
      "{}",
      new Date(NOW - 3_600_000).toISOString(),
    )
    .run();
}

/** The self-hosted Orb's configuration: public stats on, and NO own-ledger repo allowlist -- which is what
 *  silently skipped every own-ledger query and left the headline at zero. */
const orbEnv = () => createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });

describe("published totals and parity rollups cannot contradict each other (#9971)", () => {
  it("REGRESSION: the verifier's stats-parity claim PASSES for a self-hosted Orb", async () => {
    const env = orbEnv();
    for (let pull = 1; pull <= 12; pull += 1) await seedVerdict(env, pull);

    const [stats, parity] = await Promise.all([getPublicStats(env, NOW), loadReviewParityRollups(env, { nowMs: NOW })]);

    // Both surfaces read the same ledger, so they must see the same 12 pull requests. Before #9967:
    // handled=0 beside verdicts=12.
    expect(parity.verdicts).toBe(12);
    expect(stats.totals.handled).toBe(12);
    expect(checkStatsParity(stats, parity).status).toBe("pass");
  });

  it("stays consistent when a pull request is re-decided, which moves the two counts differently", async () => {
    // The sharpest case, and the one a hand-written equality assertion would get wrong. `decision_records`
    // holds one row per VERDICT, so a re-evaluation adds a row: parity counts verdicts and goes to 3, while
    // `handled` counts distinct pull requests and stays at 2. That is not a contradiction -- parity being the
    // LARGER of the two in the same direction as real volume is exactly what the verifier tolerates, and only
    // parity EXCEEDING all-time handled beyond its tolerance is the accounting error.
    const env = orbEnv();
    await seedVerdict(env, 1);
    await seedVerdict(env, 2);
    await seedVerdict(env, 2, "sha2-rev2");

    const [stats, parity] = await Promise.all([getPublicStats(env, NOW), loadReviewParityRollups(env, { nowMs: NOW })]);

    expect(parity.verdicts).toBe(3);
    expect(stats.totals.handled).toBe(2);
    expect(checkStatsParity(stats, parity).status).toBe("pass");
  });

  it("INVARIANT: an empty ledger agrees trivially rather than failing", async () => {
    // The hosted Worker's shape (review execution retired, ledger empty by design). 0 and 0 agree, and the
    // claim must not read a quiet deployment as a broken one.
    const env = orbEnv();

    const [stats, parity] = await Promise.all([getPublicStats(env, NOW), loadReviewParityRollups(env, { nowMs: NOW })]);

    expect(parity.verdicts).toBe(0);
    expect(stats.totals.handled).toBe(0);
    expect(checkStatsParity(stats, parity).status).toBe("pass");
  });

  it("MUTATION GUARD: the same claim FAILS when handled is zeroed beneath a populated rollup", async () => {
    // Proves the assertions above are driven by the numbers rather than passing for any payload at all. This
    // is byte-for-byte the contradiction production published, and the claim has to reject it.
    const env = orbEnv();
    for (let pull = 1; pull <= 12; pull += 1) await seedVerdict(env, pull);
    const parity = await loadReviewParityRollups(env, { nowMs: NOW });

    const result = checkStatsParity({ totals: { handled: 0 } }, parity);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("exceeding the all-time handled count of 0");
  });
});
