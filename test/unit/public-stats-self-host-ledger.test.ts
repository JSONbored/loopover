import { describe, expect, it } from "vitest";

import { checkStatsParity } from "../../packages/loopover-mcp/lib/verify-public-claims";
import { getPublicStats } from "../../src/review/public-stats";
import { loadReviewParityRollups } from "../../src/review/review-parity-rollups";
import { recordAuditEvent, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #9963: `totals.*` on a SELF-HOSTED Orb.
//
// The defect: an Orb published `totals.handled: 0` in the same payload as `reviewParity.verdicts: 2123`, both
// derived from its own ledger. `totals` had exactly two sources and both are hosted-Worker concepts --
// the `LOOPOVER_PUBLIC_STATS_REPOS`-allowlisted `audit_events` snapshot (a frozen list of the repos the old
// central App used to process, which no self-hoster has a reason to set) and the registered-installs fleet fold
// (which on an Orb is nobody). `decision_records`, the ledger the Orb actually writes a row to per verdict, was
// not a source at all. So every `totals.*` figure was structurally zero on the deployment that does the work.
//
// These run against a REAL migrated D1 rather than a SQL-shape stub, because the bug was that a real query
// returned nothing for a real reason -- a stub asked the wrong question and would have answered it happily.
const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const REPO = "JSONbored/loopover";

/** Insert one ledger verdict. Direct SQL, not `persistDecisionRecord`: this fixes a READ, and going through the
 *  writer would drag in digesting and the hash-chain append without making the row under test any more real. */
async function seedVerdict(env: Env, input: { repo?: string; pull: number; action?: string; at?: string }): Promise<void> {
  const repo = input.repo ?? REPO;
  const at = input.at ?? new Date(NOW - 3_600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(`record:${repo}#${input.pull}@sha${input.pull}`, repo, input.pull, `sha${input.pull}`, input.action ?? "merge", "gate_pass", "d".repeat(64), "{}", at)
    .run();
}

async function seedMergedPr(env: Env, pull: number): Promise<void> {
  await upsertRepositoryFromGitHub(env, { name: "loopover", full_name: REPO, private: false, owner: { login: "JSONbored" } }, 1);
  await upsertPullRequestFromGitHub(env, REPO, {
    number: pull,
    title: `pr ${pull}`,
    state: "closed",
    merged_at: new Date(NOW - 86_400_000).toISOString(),
    user: { login: "a" },
    head: { sha: `sha${pull}` },
    labels: [],
  });
}

describe("getPublicStats on a self-hosted Orb (#9963)", () => {
  it("REGRESSION: counts the deployment's own decision ledger instead of publishing handled: 0", async () => {
    // The Orb's exact configuration: public stats on, and NO own-ledger allowlist -- which is what silently
    // skipped every own-ledger query and left the headline at zero.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });
    for (const pull of [1, 2, 3, 4, 5]) await seedVerdict(env, { pull });

    const stats = await getPublicStats(env, NOW);

    expect(stats.totals.handled).toBe(5);
    expect(stats.totals.reviewed).toBe(5);
    // And the per-project table is no longer empty beside a non-zero headline.
    expect(stats.byProject.map((row) => row.project)).toEqual([REPO]);
    expect(stats.byProject[0]?.reviewed).toBe(5);
  });

  it("counts a PR ONCE however many verdicts the ledger holds for it", async () => {
    // Re-evaluations append rows for the same (repo, pull). `handled` counts PRs, so a re-decided PR must not
    // inflate it -- the DISTINCT is load-bearing, not incidental.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await seedVerdict(env, { pull: 1 });
    await env.DB.prepare(
      `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(`record:${REPO}#1@sha1:rev2`, REPO, 1, "sha1", "merge", "gate_pass", "e".repeat(64), "{}", new Date(NOW - 1_000).toISOString())
      .run();

    expect((await getPublicStats(env, NOW)).totals.handled).toBe(1);
  });

  it("reads the terminal disposition from the PR cache, so a merged verdict is not filed as still-in-review", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await seedMergedPr(env, 1);
    await seedVerdict(env, { pull: 1 });
    await seedVerdict(env, { pull: 2 }); // no cached PR row -> still in review

    const stats = await getPublicStats(env, NOW);
    expect(stats.totals.handled).toBe(2);
    expect(stats.totals.merged).toBe(1);
    expect(stats.totals.commented).toBe(1);
  });

  it("INVARIANT: does not double-count a PR the allowlisted published-surface query already counted", async () => {
    // With an allowlist set, both sources see the same PR. They are added, not reconciled, so the ledger
    // source must exclude exactly what the other one counts or the headline silently doubles.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: REPO });
    await seedMergedPr(env, 1);
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: `${REPO}#1`, outcome: "completed" });
    await seedVerdict(env, { pull: 1 });

    expect((await getPublicStats(env, NOW)).totals.handled).toBe(1);
  });

  it("still counts a ledger PR the allowlist EXCLUDES -- the exclusion is per counted pair, not per event", async () => {
    // The subtle way to get the anti-join wrong: drop any PR that has a published-surface event, rather than
    // only those the other query actually counts. An un-allowlisted repo publishes surfaces too, and those PRs
    // would then be counted by nobody.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/other-repo" });
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: `${REPO}#1`, outcome: "completed" });
    await seedVerdict(env, { pull: 1 });

    expect((await getPublicStats(env, NOW)).totals.handled).toBe(1);
  });

  it("INVARIANT: does not double-count a PR the registered-install fleet fold already counted", async () => {
    // The second overlap, and the easier one to forget: `getOrbGlobalStats` adds every REGISTERED install's
    // outcomes on top of the own-ledger totals. An operator running the central Orb App for telemetry beside
    // their self-hosted engine (which is exactly what JSONbored's own repos do -- see the file header) has the
    // same PR in both populations, so without this exclusion the headline counts it twice.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (?, ?, 1)`).bind(77, "JSONbored").run();
    await env.DB.prepare(`INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(REPO, 1, 77, "merged", new Date(NOW - 86_400_000).toISOString())
      .run();
    await seedVerdict(env, { pull: 1 }); // the SAME PR, also in this deployment's own ledger
    await seedVerdict(env, { pull: 2 }); // ledger-only, so the exclusion cannot pass by dropping everything

    const stats = await getPublicStats(env, NOW);
    // 1 from the fleet fold + 1 ledger-only PR. The shared PR is counted once, not twice.
    expect(stats.totals.handled).toBe(2);
  });

  it("INVARIANT: an unregistered install's outcome does NOT suppress a ledger PR", async () => {
    // The exclusion has to mirror the fleet fold's own population exactly. That fold counts only REGISTERED
    // installations, so excluding on an unregistered row would drop a PR that nothing else counts.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });
    await env.DB.prepare(`INSERT INTO orb_github_installations (installation_id, account_login, registered) VALUES (?, ?, 0)`).bind(78, "someone").run();
    await env.DB.prepare(`INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(REPO, 1, 78, "merged", new Date(NOW - 86_400_000).toISOString())
      .run();
    await seedVerdict(env, { pull: 1 });

    expect((await getPublicStats(env, NOW)).totals.handled).toBe(1);
  });

  it("INVARIANT: an empty decision ledger leaves the hosted Worker's numbers exactly where they were", async () => {
    // The hosted Worker has review execution retired, so its ledger is empty by design. This change must be a
    // no-op there -- a fix for one deployment that moves another deployment's published figures is not a fix.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: REPO });
    await seedMergedPr(env, 1);
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: `${REPO}#1`, outcome: "completed" });

    const stats = await getPublicStats(env, NOW);
    expect(stats.totals.handled).toBe(1);
    expect(stats.totals.merged).toBe(1);
  });
});

// The invariant the public verifier actually enforces, checked with the verifier's OWN function rather than a
// restatement of it -- so this cannot drift from the tool that decides whether production is publishing a
// contradiction. `checkStatsParity` is what printed the original FAIL against the Orb.
describe("published stats and parity rollups cannot contradict each other (#9963)", () => {
  it("REGRESSION: the verifier's stats-parity claim PASSES for a self-hosted Orb", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });
    for (let pull = 1; pull <= 12; pull += 1) await seedVerdict(env, { pull });

    const [stats, parity] = await Promise.all([getPublicStats(env, NOW), loadReviewParityRollups(env, { nowMs: NOW })]);

    // Both surfaces see the same ledger. Before the fix: handled=0 beside verdicts=12.
    expect(parity.verdicts).toBe(12);
    expect(stats.totals.handled).toBe(12);

    const result = checkStatsParity(stats, parity);
    expect(result.status).toBe("pass");
  });

  it("MUTATION GUARD: the same claim FAILS when handled is zeroed beneath a populated rollup", async () => {
    // Proves the assertion above is driven by the numbers rather than passing for any payload at all. This is
    // the exact contradiction production published.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true", LOOPOVER_PUBLIC_STATS_REPOS: "" });
    for (let pull = 1; pull <= 12; pull += 1) await seedVerdict(env, { pull });
    const parity = await loadReviewParityRollups(env, { nowMs: NOW });

    const result = checkStatsParity({ totals: { handled: 0 } }, parity);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("exceeding the all-time handled count of 0");
  });
});
