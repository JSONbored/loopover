import { describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/processors";
import {
  createFlagStore,
  isHoldOnly,
  parseRevertedPrNumber,
  recordPrOutcome,
  recordReversalSignals,
  runSelfTuneBreaker,
} from "../../src/review/outcomes-wire";
import { applyAutoTune, type GateEvalReport } from "../../src/review/auto-tune";
import { downgradeMergeToHold, type PlannedAgentAction } from "../../src/settings/agent-actions";
import { recordAuditEvent } from "../../src/db/repositories";
import type { GitHubPullRequestPayload } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────

async function reviewAuditRows(env: Env, eventType: string): Promise<Array<{ project: string; target_id: string; decision: string | null; summary: string | null }>> {
  const res = await env.DB.prepare("SELECT project, target_id, decision, summary FROM review_audit WHERE event_type = ?")
    .bind(eventType)
    .all<{ project: string; target_id: string; decision: string | null; summary: string | null }>();
  return res.results ?? [];
}

async function auditEventRows(env: Env, eventType: string): Promise<Array<{ target_key: string | null; detail: string | null }>> {
  const res = await env.DB.prepare("SELECT target_key, detail FROM audit_events WHERE event_type = ?")
    .bind(eventType)
    .all<{ target_key: string | null; detail: string | null }>();
  return res.results ?? [];
}

/** Seed the bot's own last action on a PR into the agent-action audit ledger (audit_events). */
async function seedBotAction(env: Env, targetKey: string, actionClass: "close" | "merge" | "approve", outcome: "success" | "denied" = "success"): Promise<void> {
  await recordAuditEvent(env, { eventType: `agent.action.${actionClass}`, targetKey, outcome });
}

function pullRequestPayload(over: Partial<GitHubPullRequestPayload> = {}): GitHubPullRequestPayload {
  return { number: 7, title: "PR", state: "closed", head: { sha: "s7" }, labels: [], ...over };
}

// ── 1) pr_outcome — realized ground truth (merged + closed) ───────────────────────────────────────────────────

describe("recordPrOutcome — realized merge/close ground truth", () => {
  it("writes a pr_outcome=merged row (review_audit + audit_events) on a merged PR close", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 42, merged_at: "2026-06-20T00:00:00.000Z" }),
      sender: { login: "owner", type: "User" },
    });
    const eval_ = await reviewAuditRows(env, "pr_outcome");
    expect(eval_).toHaveLength(1);
    expect(eval_[0]).toMatchObject({ project: "owner/repo", target_id: "owner/repo#42", decision: "merged" });
    const ledger = await auditEventRows(env, "pr_outcome");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ target_key: "owner/repo#42", detail: "merged" });
  });

  it("writes a pr_outcome=closed row when a PR is closed WITHOUT merging", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 43, merged_at: null }),
      sender: { login: "contributor", type: "User" },
    });
    expect((await reviewAuditRows(env, "pr_outcome"))[0]).toMatchObject({ target_id: "owner/repo#43", decision: "closed" });
    expect((await auditEventRows(env, "pr_outcome"))[0]).toMatchObject({ detail: "closed" });
  });

  it("records NOTHING for a non-closed action or a payload with no PR number", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", { action: "opened", repository: { name: "repo", full_name: "owner/repo" }, pull_request: pullRequestPayload({ number: 44, state: "open" }) });
    await recordPrOutcome(env, "pull_request", { action: "closed", repository: { name: "repo", full_name: "owner/repo" } });
    expect(await reviewAuditRows(env, "pr_outcome")).toHaveLength(0);
    expect(await auditEventRows(env, "pr_outcome")).toHaveLength(0);
  });
});

// ── 2) reversal_reopened — a contributor reopened a bot-CLOSED PR ──────────────────────────────────────────────

describe("recordReversalSignals — reversal_reopened", () => {
  it("writes reversal_reopened (review_audit + audit_events) when a contributor reopens a bot-CLOSED PR", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "close"); // the bot's last action on this PR was a close
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "contributor", type: "User" }, // not the owner, not a bot → a genuine dispute
    });
    const eval_ = await reviewAuditRows(env, "reversal_reopened");
    expect(eval_).toHaveLength(1);
    expect(eval_[0]).toMatchObject({ project: "owner/repo", target_id: "owner/repo#7" });
    expect(await auditEventRows(env, "reversal_reopened")).toHaveLength(1);
  });

  it("does NOT record when the last bot action on the PR was NOT a close (e.g. merge/approve)", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "approve");
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
  });

  it("does NOT record an OWNER reopen or a BOT reopen (administrative / not a contributor dispute)", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "close");
    // Owner reopen — administrative re-queue, not a dispute.
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "owner", type: "User" },
    });
    // Bot reopen — not a human dispute.
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "some-bot[bot]", type: "Bot" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
  });

  it("records reversal_reverted against PR #N for a merged \"Reverts #N\" PR", async () => {
    const env = createTestEnv();
    await recordReversalSignals(env, "pull_request", {
      action: "closed",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 99, merged_at: "2026-06-20T00:00:00.000Z", body: "Reverts #50\n\nThis reverts the change." }),
      sender: { login: "contributor", type: "User" },
    });
    const eval_ = await reviewAuditRows(env, "reversal_reverted");
    expect(eval_).toHaveLength(1);
    expect(eval_[0]).toMatchObject({ target_id: "owner/repo#50" });
    expect(await auditEventRows(env, "reversal_reverted")).toHaveLength(1);
  });

  it("does NOT record reversal_reverted for a merged PR whose body is not a revert", async () => {
    const env = createTestEnv();
    await recordReversalSignals(env, "pull_request", {
      action: "closed",
      repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
      pull_request: pullRequestPayload({ number: 99, merged_at: "2026-06-20T00:00:00.000Z", body: "A normal feature PR." }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reverted")).toHaveLength(0);
  });
});

describe("parseRevertedPrNumber (pure)", () => {
  it("parses #N and owner/repo#N revert bodies; undefined otherwise", () => {
    expect(parseRevertedPrNumber("Reverts #123")).toBe(123);
    expect(parseRevertedPrNumber("Reverts owner/repo#7")).toBe(7);
    expect(parseRevertedPrNumber("A normal PR")).toBeUndefined();
    expect(parseRevertedPrNumber(null)).toBeUndefined();
  });
});

// ── 3a) downgradeMergeToHold (pure) — the precision-breaker merge→hold transform ───────────────────────────────

describe("downgradeMergeToHold (pure)", () => {
  const mergeAction: PlannedAgentAction = { actionClass: "merge", requiresApproval: false, reason: "ready" };
  const readyLabel: PlannedAgentAction = { actionClass: "label", requiresApproval: false, reason: "ready", label: "gittensory:ready-to-merge", labelOp: "add" };
  const closeAction: PlannedAgentAction = { actionClass: "close", requiresApproval: false, reason: "bad" };

  it("holdOnly=false → returns the plan UNCHANGED (byte-identical common path)", () => {
    const plan = [readyLabel, mergeAction];
    expect(downgradeMergeToHold(plan, false)).toBe(plan);
  });

  it("holdOnly=true + a planned merge → drops the merge + ready label, adds needs-human-review", () => {
    const out = downgradeMergeToHold([readyLabel, mergeAction], true);
    expect(out.some((a) => a.actionClass === "merge")).toBe(false);
    expect(out.some((a) => a.actionClass === "label" && a.label === "gittensory:ready-to-merge")).toBe(false);
    expect(out.some((a) => a.actionClass === "label" && a.label === "gittensory:needs-human-review" && a.labelOp === "add")).toBe(true);
  });

  it("holdOnly=true but NO merge planned (e.g. a close) → no-op (returns the plan unchanged)", () => {
    const plan = [closeAction];
    expect(downgradeMergeToHold(plan, true)).toBe(plan);
  });
});

// ── 3b) live FlagStore + isHoldOnly + the breaker tick ─────────────────────────────────────────────────────────

describe("isHoldOnly + createFlagStore (system_flags, migration 0054)", () => {
  it("isHoldOnly is false with no flags, true once holdonly:<project> is set, and respects holdonly:global", async () => {
    const env = createTestEnv();
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
    const flags = createFlagStore(env);
    await flags.setFlag("holdonly:owner/repo", true);
    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
    expect(await isHoldOnly(env, "owner/other")).toBe(false);
    await flags.setFlag("holdonly:owner/repo", false);
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
    // global breaker applies to every project.
    await flags.setFlag("holdonly:global", true);
    expect(await isHoldOnly(env, "any/repo")).toBe(true);
  });

  it("flagSetAt round-trips the updated_at and is null when unset", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    expect(await flags.flagSetAt("holdonly:owner/repo")).toBeNull();
    await flags.setFlag("holdonly:owner/repo", true);
    expect(await flags.flagSetAt("holdonly:owner/repo")).toBeTruthy();
  });
});

describe("applyAutoTune over the live FlagStore — engages holdonly on low merge precision", () => {
  it("engages holdonly:<project> when merge precision is below the floor over a real sample", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    // 5 confirmed / 12 would-merge = ~42% precision over 12 decided → below the 85% floor with a real sample.
    const report: GateEvalReport = {
      rows: [{ project: "owner/repo", wouldMerge: 12, mergeConfirmed: 5, mergeFalse: 7, wouldClose: 0, closeConfirmed: 0, closeFalse: 0, hold: 0, decided: 12, mergePrecision: 5 / 12, closePrecision: null }],
      hasSignal: true,
    };
    const engaged = await applyAutoTune(flags, report);
    expect(engaged.map((a) => a.project)).toEqual(["owner/repo"]);
    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
  });
});

describe("runSelfTuneBreaker — reads recorded pr_outcome ground truth + engages/clears the breaker", () => {
  // Seed a gate_decision prediction + the realized pr_outcome for one PR (the join computeGateEval folds).
  async function seedDecisionAndOutcome(env: Env, project: string, pr: number, pred: "merge" | "close", truth: "merged" | "closed"): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'gate_decision', ?, 'gittensory-native', ?, NULL, CURRENT_TIMESTAMP)",
    )
      .bind(`gd:${project}#${pr}`, project, `${project}#${pr}`, pred, `sha${pr}`)
      .run();
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'pr_outcome', ?, 'gittensory-native', NULL, NULL, CURRENT_TIMESTAMP)",
    )
      .bind(`po:${project}#${pr}`, project, `${project}#${pr}`, truth)
      .run();
  }

  it("ENGAGES the breaker when recorded outcomes show merge precision below the floor", async () => {
    const env = createTestEnv();
    // 12 would-merge predictions: 4 confirmed merged, 8 the human actually CLOSED → 33% precision over 12 decided.
    for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcome(env, "owner/repo", i, "merge", "merged");
    for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcome(env, "owner/repo", i, "merge", "closed");

    await runSelfTuneBreaker(env);

    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
  });

  it("does NOT engage with no recorded outcome history (fail-safe / byte-identical)", async () => {
    const env = createTestEnv();
    await runSelfTuneBreaker(env);
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("never throws (fails safe) even when review_audit reads blow up", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/review_audit/i.test(sql)) throw new Error("poisoned");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runSelfTuneBreaker(env)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

// ── integration: the PR-closed webhook records pr_outcome through processJob ────────────────────────────────────

describe("processJob(github-webhook) wires pr_outcome recording on a PR close", () => {
  it("a closed+merged pull_request webhook records the pr_outcome ground truth", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      return new Response("not found", { status: 404 });
    });
    try {
      await processJob(env, {
        type: "github-webhook",
        deliveryId: "gap4-pr-outcome-merged",
        eventName: "pull_request",
        payload: {
          action: "closed",
          installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
          repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: true, owner: { login: "JSONbored" } },
          pull_request: { number: 5151, title: "Merged PR", state: "closed", merged_at: "2026-06-20T00:00:00.000Z", user: { login: "contributor" }, head: { sha: "abc123" }, labels: [], body: "Adds a feature." },
          sender: { login: "contributor", type: "User" },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const eval_ = await reviewAuditRows(env, "pr_outcome");
    expect(eval_.some((r) => r.target_id === "JSONbored/gittensory#5151" && r.decision === "merged")).toBe(true);
  });
});
