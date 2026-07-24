import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderTrackRecord } from "@loopover/engine";
import * as repositories from "../../src/db/repositories";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import {
  computeWouldHaveRouted,
  loadLiveProviderTrackRecords,
  recordRoutingShadow,
  REVIEWER_ROUTING_SHADOW_EVENT_TYPE,
  REVIEWER_VOTE_EVENT_TYPE,
  ROUTING_MIN_DECIDED,
} from "../../src/services/reviewer-routing";
import { buildRoutingRecapSection } from "../../src/services/maintainer-recap-routing";
import { formatMaintainerRecap, runMaintainerRecap } from "../../src/services/maintainer-recap";
import { createTestEnv } from "../helpers/d1";

// #8229 stage 1: the report-only routing shadow. The aggregation itself is #8228's (engine suite); these
// tests pin the preference rule's every refusal arm, the live-vote read path, the best-effort write, and
// the recap section.

const REPO = "acme/widgets";

function record(provider: string, over: Partial<ProviderTrackRecord> = {}): ProviderTrackRecord {
  return {
    provider,
    repoFullName: REPO,
    signals: 12,
    decided: 12,
    confirmed: 8,
    reversed: 4,
    precision: 0.7,
    agreementRate: 0.6,
    consensusRate: 0.5,
    splitRate: 0.5,
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeWouldHaveRouted (#8229 stage 1)", () => {
  const PAIR = ["claude-code", "codex"];

  it("prefers the strictly-leading provider with the full basis attached", () => {
    const decision = computeWouldHaveRouted([record("claude-code", { precision: 0.9 }), record("codex", { precision: 0.6 })], REPO, PAIR);
    expect(decision).toEqual({
      repoFullName: REPO,
      preferredProvider: "claude-code",
      actualProviders: PAIR,
      basis: [
        { provider: "claude-code", decided: 12, precision: 0.9 },
        { provider: "codex", decided: 12, precision: 0.6 },
      ],
    });
  });

  it("refuses EVERY no-signal arm: lone reviewer, missing repo row, below the decided floor, null precision, tie", () => {
    const dense = [record("claude-code", { precision: 0.9 }), record("codex", { precision: 0.6 })];
    expect(computeWouldHaveRouted(dense, REPO, ["claude-code"])).toBeNull();
    expect(computeWouldHaveRouted([dense[0]!], REPO, PAIR)).toBeNull(); // codex has no repo row
    expect(computeWouldHaveRouted([dense[0]!, record("codex", { repoFullName: null })], REPO, PAIR)).toBeNull(); // overall rollup never counts
    expect(computeWouldHaveRouted([dense[0]!, record("codex", { decided: ROUTING_MIN_DECIDED - 1 })], REPO, PAIR)).toBeNull();
    expect(computeWouldHaveRouted([dense[0]!, record("codex", { precision: null })], REPO, PAIR)).toBeNull();
    expect(computeWouldHaveRouted([record("claude-code"), record("codex")], REPO, PAIR)).toBeNull(); // 0.7 === 0.7
  });
});

describe("loadLiveProviderTrackRecords (#8229 stage 1 read path)", () => {
  it("joins live reviewer_vote rows to the labeled corpus; corrupt/malformed vote rows are never evidence", async () => {
    const env = createTestEnv();
    const store = createSignalStore(env);
    const now = Date.now();
    for (let i = 1; i <= 3; i += 1) {
      const targetKey = `${REPO}#${i}`;
      await store.recordRuleFired({ ruleId: "ai_consensus_defect", targetKey, outcome: "close", occurredAt: new Date(now - 10_000 - i).toISOString(), metadata: { confidence: 0.97 } });
      await store.recordHumanOverride({ ruleId: "ai_consensus_defect", targetKey, verdict: i === 3 ? "reversed" : "confirmed", occurredAt: new Date(now - i).toISOString() });
      await repositories.recordAuditEvent(env, {
        eventType: REVIEWER_VOTE_EVENT_TYPE,
        actor: "claude-code",
        targetKey,
        outcome: "completed",
        detail: "vote",
        metadata: { repoFullName: REPO, vote: i === 3 ? "non_fail" : "fail" },
      });
    }
    // Malformed rows: missing repoFullName, foreign vote value, unparseable metadata.
    await repositories.recordAuditEvent(env, { eventType: REVIEWER_VOTE_EVENT_TYPE, actor: "claude-code", targetKey: `${REPO}#9`, outcome: "completed", detail: "v", metadata: { vote: "fail" } });
    await repositories.recordAuditEvent(env, { eventType: REVIEWER_VOTE_EVENT_TYPE, actor: "claude-code", targetKey: `${REPO}#10`, outcome: "completed", detail: "v", metadata: { repoFullName: REPO, vote: "maybe" } });
    await env.DB.prepare("INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES ('corrupt', ?, 'claude-code', ?, 'completed', 'v', 'not json', ?)")
      .bind(REVIEWER_VOTE_EVENT_TYPE, `${REPO}#11`, new Date(now).toISOString())
      .run();

    const records = await loadLiveProviderTrackRecords(env, now);
    const repoRow = records.find((row) => row.provider === "claude-code" && row.repoFullName === REPO)!;
    expect(repoRow.signals).toBe(3); // the three valid votes only
    expect(repoRow.decided).toBe(3);
    expect(repoRow.precision).toBe(1); // both fail votes landed on confirmed labels
  });

  it("fails safe to [] on a broken store", async () => {
    const env = createTestEnv();
    env.DB = { prepare: () => { throw new Error("store down"); } } as never;
    expect(await loadLiveProviderTrackRecords(env)).toEqual([]);
  });
});

describe("recordRoutingShadow (#8229 stage 1 write path)", () => {
  async function seedDensePreference(env: Env): Promise<void> {
    const store = createSignalStore(env);
    const now = Date.now();
    for (let i = 1; i <= ROUTING_MIN_DECIDED + 2; i += 1) {
      const targetKey = `${REPO}#${i}`;
      await store.recordRuleFired({ ruleId: "ai_consensus_defect", targetKey, outcome: "close", occurredAt: new Date(now - 10_000 - i).toISOString(), metadata: { confidence: 0.97 } });
      await store.recordHumanOverride({ ruleId: "ai_consensus_defect", targetKey, verdict: i % 2 === 0 ? "reversed" : "confirmed", occurredAt: new Date(now - i).toISOString() });
      // claude-code votes fail on CONFIRMED targets only (perfect precision); codex on REVERSED only (0).
      await repositories.recordAuditEvent(env, {
        eventType: REVIEWER_VOTE_EVENT_TYPE,
        actor: "claude-code",
        targetKey,
        outcome: "completed",
        detail: "vote",
        metadata: { repoFullName: REPO, vote: i % 2 === 0 ? "non_fail" : "fail" },
      });
      await repositories.recordAuditEvent(env, {
        eventType: REVIEWER_VOTE_EVENT_TYPE,
        actor: "codex",
        targetKey,
        outcome: "completed",
        detail: "vote",
        metadata: { repoFullName: REPO, vote: i % 2 === 0 ? "fail" : "non_fail" },
      });
    }
  }

  it("records ONE shadow event with the full decision metadata when a measurable preference exists", async () => {
    const env = createTestEnv();
    await seedDensePreference(env);
    const decision = await recordRoutingShadow(env, { repoFullName: REPO, prNumber: 77, actualProviders: ["claude-code", "codex"] });
    expect(decision?.preferredProvider).toBe("claude-code");
    const rows = await env.DB.prepare("SELECT target_key, metadata_json FROM audit_events WHERE event_type = ?")
      .bind(REVIEWER_ROUTING_SHADOW_EVENT_TYPE)
      .all<{ target_key: string; metadata_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.target_key).toBe(`${REPO}#77`);
    const metadata = JSON.parse(rows.results![0]!.metadata_json) as { preferredProvider: string; basis: unknown[] };
    expect(metadata.preferredProvider).toBe("claude-code");
    expect(metadata.basis).toHaveLength(2);
  });

  it("records NOTHING without density, and stays fail-safe when the audit write rejects or the read throws", async () => {
    const sparse = createTestEnv();
    expect(await recordRoutingShadow(sparse, { repoFullName: REPO, prNumber: 1, actualProviders: ["claude-code", "codex"] })).toBeNull();
    expect((await sparse.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ?").bind(REVIEWER_ROUTING_SHADOW_EVENT_TYPE).first<{ n: number }>())?.n).toBe(0);

    const env = createTestEnv();
    await seedDensePreference(env);
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("audit down"));
    const decision = await recordRoutingShadow(env, { repoFullName: REPO, prNumber: 2, actualProviders: ["claude-code", "codex"] });
    expect(decision?.preferredProvider).toBe("claude-code"); // decision computed; the write's rejection was swallowed
    vi.restoreAllMocks();

    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    expect(await recordRoutingShadow(broken, { repoFullName: REPO, prNumber: 3, actualProviders: ["claude-code", "codex"] })).toBeNull();

    // The OUTER fail-safe: a synchronously-throwing audit writer (no promise to .catch) must also reduce
    // to null, never into the review path.
    const throwing = createTestEnv();
    await seedDensePreference(throwing);
    vi.spyOn(repositories, "recordAuditEvent").mockImplementation(() => {
      throw new Error("sync boom");
    });
    expect(await recordRoutingShadow(throwing, { repoFullName: REPO, prNumber: 4, actualProviders: ["claude-code", "codex"] })).toBeNull();
  });
});

describe("routing recap section (#8229 stage 1 surfacing)", () => {
  const decision = {
    repoFullName: REPO,
    preferredProvider: "claude-code",
    actualProviders: ["claude-code", "codex"],
    basis: [
      { provider: "claude-code", decided: 12, precision: 0.9 },
      { provider: "codex", decided: 12, precision: 0.6 },
    ],
  };

  it("renders the explicit empty line, and grouped lines with the mean edge + report-only footer otherwise", () => {
    expect(buildRoutingRecapSection({ decisions: [], windowDays: 7 }).lines[0]).toContain("No would-have-routed decisions");
    const section = buildRoutingRecapSection({ decisions: [decision, decision, { ...decision, basis: [decision.basis[0]!] }], windowDays: 7 });
    expect(section.title).toContain("last 7d");
    expect(section.lines[0]).toContain("preferred claude-code on 3 review(s)");
    expect(section.lines[0]).toContain("0.200"); // mean edge (0.3 + 0.3 + 0-for-malformed) / 3
    expect(section.lines.at(-1)).toContain("Report-only");
  });

  it("rides formatMaintainerRecap as an optional section and the recap job wires it from the audit trail", async () => {
    const env = createTestEnv();
    await repositories.recordAuditEvent(env, {
      eventType: REVIEWER_ROUTING_SHADOW_EVENT_TYPE,
      actor: "loopover",
      targetKey: `${REPO}#5`,
      outcome: "completed",
      detail: "shadow",
      metadata: decision,
    });
    const result = await runMaintainerRecap(env, { repos: [], generatedAt: new Date().toISOString() });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.formatted).toContain("Reviewer routing shadow");
    expect(result.formatted).toContain("preferred claude-code on 1 review(s)");

    // The option is additive: no option ⇒ no section header.
    expect(formatMaintainerRecap(result.report)).not.toContain("Reviewer routing shadow");
  });

  it("the recap survives a broken audit store: the section is simply absent (fail-safe null arm)", async () => {
    const env = createTestEnv();
    // Break ONLY the routing-shadow read — the rest of the recap's own store use must stay real, so the
    // test proves the SECTION fails safe rather than the whole recap being down.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB = {
      ...env.DB,
      prepare: (sql: string) => {
        if (sql.includes("SELECT metadata_json FROM audit_events")) throw new Error("store down");
        return realPrepare(sql);
      },
    } as never;
    const result = await runMaintainerRecap(env, { repos: [], generatedAt: new Date().toISOString() });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.formatted).not.toContain("Reviewer routing shadow");
  });
});
