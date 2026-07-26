import { describe, expect, it } from "vitest";
import {
  DECISION_AUDIT_RUBRIC_VERSION,
  DECISION_AUDIT_SAMPLE_SIZE,
  isDecisionAuditEnabled,
  planAuditSample,
  runDecisionAuditSample,
  type AuditCandidate,
} from "../../src/review/decision-audit";
import { processJob } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";

// #8830: the human-label pipeline. The sampler decides WHO gets audited — a biased or flappy draw would
// corrupt every estimate built on the labels, so determinism and strata behavior are pinned exactly.
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function candidate(i: number, over: Partial<AuditCandidate> = {}): AuditCandidate {
  return { targetId: `o/r#${i}`, project: "o/r", verdict: "merge", outcome: "merged", firstTimeAuthor: false, ...over };
}

describe("isDecisionAuditEnabled", () => {
  it("truthy strings enable; default is OFF", () => {
    expect(isDecisionAuditEnabled({ LOOPOVER_DECISION_AUDIT: "true" })).toBe(true);
    expect(isDecisionAuditEnabled({ LOOPOVER_DECISION_AUDIT: "0" })).toBe(false);
    expect(isDecisionAuditEnabled({})).toBe(false);
  });
});

describe("planAuditSample (#8830)", () => {
  it("is DETERMINISTIC under a seeded rng — same inputs, same draw", () => {
    const pool = Array.from({ length: 100 }, (_, i) => candidate(i, { verdict: i % 3 === 0 ? "close" : "merge", outcome: i % 3 === 0 ? "closed" : "merged", firstTimeAuthor: i % 10 === 0 }));
    const a = planAuditSample(pool, 30, seededRng(42));
    const b = planAuditSample(pool, 30, seededRng(42));
    expect(a).toEqual(b);
    const c = planAuditSample(pool, 30, seededRng(43));
    expect(c.map((r) => r.targetId)).not.toEqual(a.map((r) => r.targetId)); // a different seed draws differently
  });

  it("fills strata quotas when the pool is rich: ~50% merges, ~30% closes, ~20% first-time", () => {
    const pool = [
      ...Array.from({ length: 40 }, (_, i) => candidate(i)),
      ...Array.from({ length: 40 }, (_, i) => candidate(100 + i, { verdict: "close", outcome: "closed" })),
      ...Array.from({ length: 40 }, (_, i) => candidate(200 + i, { firstTimeAuthor: true })),
    ];
    const plan = planAuditSample(pool, 30, seededRng(7));
    expect(plan).toHaveLength(30);
    const byStratum = new Map<string, number>();
    for (const row of plan) byStratum.set(row.stratum, (byStratum.get(row.stratum) ?? 0) + 1);
    expect(byStratum.get("first_time_author")).toBe(6);
    expect(byStratum.get("merge_arm")).toBe(15);
    expect(byStratum.get("close_arm")).toBe(9);
    expect(new Set(plan.map((r) => r.targetId)).size).toBe(30); // no duplicates ever
  });

  it("a thin stratum SPILLS into the rest instead of shrinking the week's sample", () => {
    // No first-time authors and only 3 closes: their quotas spill to merges.
    const pool = [...Array.from({ length: 50 }, (_, i) => candidate(i)), ...Array.from({ length: 3 }, (_, i) => candidate(100 + i, { verdict: "close", outcome: "closed" }))];
    const plan = planAuditSample(pool, 30, seededRng(7));
    expect(plan).toHaveLength(30);
    expect(plan.filter((r) => r.stratum === "close_arm")).toHaveLength(3);
    expect(plan.filter((r) => r.stratum === "first_time_author")).toHaveLength(0);
    expect(plan.filter((r) => r.stratum === "merge_arm")).toHaveLength(27);
  });

  it("the spill tags a close candidate close_arm when the close quota is already spent", () => {
    // 3 closes fill the close quota (k=10 -> quota 3); the 4th close arrives via the spill and must still be
    // tagged by its own arm, not mislabeled.
    const pool = [...Array.from({ length: 4 }, (_, i) => candidate(100 + i, { verdict: "close", outcome: "closed" })), ...Array.from({ length: 3 }, (_, i) => candidate(i))];
    const plan = planAuditSample(pool, 10, seededRng(3));
    expect(plan).toHaveLength(7);
    expect(plan.filter((r) => r.stratum === "close_arm")).toHaveLength(4);
  });

  it("returns the whole pool (each once) when the pool is smaller than k, and [] for empty/k<=0", () => {
    const pool = [candidate(1), candidate(2, { verdict: "close", outcome: "closed" })];
    expect(planAuditSample(pool, 30, seededRng(1))).toHaveLength(2);
    expect(planAuditSample([], 30, seededRng(1))).toEqual([]);
    expect(planAuditSample(pool, 0, seededRng(1))).toEqual([]);
  });

  it("a first-time author claimed by the first-time stratum is never double-drawn by an arm stratum", () => {
    const pool = [candidate(1, { firstTimeAuthor: true }), candidate(2)];
    const plan = planAuditSample(pool, 2, seededRng(5));
    expect(plan).toHaveLength(2);
    expect(plan.filter((r) => r.targetId === "o/r#1")).toHaveLength(1);
  });
});

describe("runDecisionAuditSample (#8830) — end-to-end over the real ledger", () => {
  async function seedDecision(env: Env, n: number, verdict: "merge" | "close", outcome: "merged" | "closed", author: string, opts: { policyClose?: boolean; old?: boolean } = {}): Promise<void> {
    const at = opts.old ? "2026-01-01T00:00:00.000Z" : new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, summary, created_at) VALUES (?, 'o/r', ?, 'gate_decision', ?, 'gittensory-native', ?, ?)`,
    )
      .bind(`gd-${n}`, `o/r#${n}`, verdict, opts.policyClose ? "policy_close:contributor_cap" : "success", at)
      .run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, 'o/r', ?, 'pr_outcome', ?, 'gittensory-native', ?)`,
    )
      .bind(`po-${n}`, `o/r#${n}`, outcome, at)
      .run();
    await env.DB.prepare(`INSERT INTO pull_requests (repo_full_name, number, title, state, author_login) VALUES ('o/r', ?, 't', 'closed', ?)`).bind(n, author).run();
  }

  it("samples recent decided PRs into PENDING rows, tags first-time authors, and excludes policy closes + old decisions", async () => {
    const env = createTestEnv();
    await seedDecision(env, 1, "merge", "merged", "veteran");
    await seedDecision(env, 2, "merge", "merged", "veteran"); // veteran has 2 PRs -> not first-time
    await seedDecision(env, 3, "close", "closed", "newbie"); // newbie's only PR -> first-time
    await seedDecision(env, 4, "close", "closed", "capped", { policyClose: true }); // enforcement — excluded
    await seedDecision(env, 5, "merge", "merged", "old-timer", { old: true }); // outside the 7d window
    const inserted = await runDecisionAuditSample(env, Date.now(), () => 0.5);
    expect(inserted).toBe(3);
    const rows = await env.DB.prepare("SELECT target_id, stratum, status, rubric_version FROM decision_audit_labels ORDER BY target_id").all<{ target_id: string; stratum: string; status: string; rubric_version: string }>();
    expect(rows.results!.map((r) => r.target_id)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    expect(rows.results!.find((r) => r.target_id === "o/r#3")!.stratum).toBe("first_time_author");
    for (const row of rows.results!) {
      expect(row.status).toBe("pending");
      expect(row.rubric_version).toBe(DECISION_AUDIT_RUBRIC_VERSION);
    }
  });

  it("NEVER double-samples a PR across runs (UNIQUE target) and returns 0 on an empty window", async () => {
    const env = createTestEnv();
    await seedDecision(env, 1, "merge", "merged", "a");
    expect(await runDecisionAuditSample(env, Date.now(), () => 0.5)).toBe(1);
    expect(await runDecisionAuditSample(env, Date.now(), () => 0.5)).toBe(0); // candidate query excludes sampled targets
    const empty = createTestEnv();
    expect(await runDecisionAuditSample(empty, Date.now(), () => 0.5)).toBe(0);
  });

  it("a concurrent double-run never double-inserts (INSERT OR IGNORE on the UNIQUE target)", async () => {
    const env = createTestEnv();
    await seedDecision(env, 1, "merge", "merged", "a");
    const [a, b] = await Promise.all([runDecisionAuditSample(env, Date.now(), () => 0.5), runDecisionAuditSample(env, Date.now(), () => 0.5)]);
    expect(a + b).toBe(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_audit_labels").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("a failing insert is logged and skipped without voiding the batch", async () => {
    const env = createTestEnv();
    await seedDecision(env, 1, "merge", "merged", "a");
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT OR IGNORE INTO decision_audit_labels")) throw new Error("disk full");
      return realPrepare(sql);
    });
    expect(await runDecisionAuditSample(env, Date.now(), () => 0.5)).toBe(0);
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("caps a huge week at DECISION_AUDIT_SAMPLE_SIZE", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= DECISION_AUDIT_SAMPLE_SIZE + 20; i += 1) await seedDecision(env, i, i % 2 ? "merge" : "close", i % 2 ? "merged" : "closed", `author${i}`);
    expect(await runDecisionAuditSample(env, Date.now(), seededRng(9))).toBe(DECISION_AUDIT_SAMPLE_SIZE);
  });

  it("a PR with no cached pull_requests row degrades to not-first-time instead of guessing", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, summary, created_at) VALUES ('gd-9', 'o/r', 'o/r#9', 'gate_decision', 'merge', 'gittensory-native', 'success', ?)`,
    ).bind(new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES ('po-9', 'o/r', 'o/r#9', 'pr_outcome', 'merged', 'gittensory-native', ?)`,
    ).bind(new Date().toISOString()).run();
    expect(await runDecisionAuditSample(env, Date.now(), () => 0.5)).toBe(1);
    const row = await env.DB.prepare("SELECT stratum FROM decision_audit_labels WHERE target_id = 'o/r#9'").first<{ stratum: string }>();
    expect(row!.stratum).toBe("merge_arm");
  });
});

describe("decision-audit-sample job dispatch (#8830)", () => {
  it("flag-ON runs the sample; flag-OFF (or a stale queued job after a flip) does ZERO work", async () => {
    const env = createTestEnv({ LOOPOVER_DECISION_AUDIT: "true" });
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, summary, created_at) VALUES ('gd-1', 'o/r', 'o/r#1', 'gate_decision', 'merge', 'gittensory-native', 'success', ?)`,
    ).bind(new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES ('po-1', 'o/r', 'o/r#1', 'pr_outcome', 'merged', 'gittensory-native', ?)`,
    ).bind(new Date().toISOString()).run();
    await processJob(env, { type: "decision-audit-sample", requestedBy: "test" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_audit_labels").first<{ n: number }>();
    expect(n!.n).toBe(1);

    const off = createTestEnv();
    await env.DB.prepare("DELETE FROM decision_audit_labels").run();
    await processJob(off, { type: "decision-audit-sample", requestedBy: "test" });
    const zero = await off.DB.prepare("SELECT COUNT(*) AS n FROM decision_audit_labels").first<{ n: number }>();
    expect(zero!.n).toBe(0);
  });
});
