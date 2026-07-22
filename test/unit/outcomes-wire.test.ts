import { describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/processors";
import {
  createFlagStore,
  isCloseHoldOnly,
  isHoldOnly,
  parseRevertedPrNumber,
  recordPrOutcome,
  recordReversalSignals,
  resolveDispositionReason,
  runSelfTuneBreaker,
} from "../../src/review/outcomes-wire";
import { applyAutoTune, type GateEvalReport } from "../../src/review/auto-tune";
import {
  AGENT_LABEL_NEEDS_REVIEW,
  AGENT_LABEL_READY,
  downgradeMergeToHold,
  type PlannedAgentAction,
} from "../../src/settings/agent-actions";
import { recordAuditEvent } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import type { GitHubPullRequestPayload } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────

async function reviewAuditRows(
  env: Env,
  eventType: string,
): Promise<
  Array<{
    project: string;
    target_id: string;
    decision: string | null;
    summary: string | null;
  }>
> {
  const res = await env.DB.prepare(
    "SELECT project, target_id, decision, summary FROM review_audit WHERE event_type = ?",
  )
    .bind(eventType)
    .all<{
      project: string;
      target_id: string;
      decision: string | null;
      summary: string | null;
    }>();
  return res.results ?? [];
}

async function auditEventRows(
  env: Env,
  eventType: string,
): Promise<Array<{ target_key: string | null; detail: string | null }>> {
  const res = await env.DB.prepare(
    "SELECT target_key, detail FROM audit_events WHERE event_type = ?",
  )
    .bind(eventType)
    .all<{ target_key: string | null; detail: string | null }>();
  return res.results ?? [];
}

/** Seed the bot's own last action on a PR into the agent-action audit ledger (audit_events). */
// Default outcome "completed" mirrors what the executor actually writes for a performed action (buildAgentActionAudit).
async function seedBotAction(
  env: Env,
  targetKey: string,
  actionClass: "close" | "merge" | "approve",
  outcome: "success" | "completed" | "denied" = "completed",
  mode?: "live" | "dry_run",
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: `agent.action.${actionClass}`,
    targetKey,
    outcome,
    metadata: mode ? { mode } : undefined,
  });
}

function pullRequestPayload(
  over: Partial<GitHubPullRequestPayload> = {},
): GitHubPullRequestPayload {
  return {
    number: 7,
    title: "PR",
    state: "closed",
    head: { sha: "s7" },
    labels: [],
    ...over,
  };
}

// ── 1) pr_outcome — realized ground truth (merged + closed) ───────────────────────────────────────────────────

describe("recordPrOutcome — realized merge/close ground truth", () => {
  it("writes a pr_outcome=merged row (review_audit + audit_events) on a merged PR close", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 42,
        merged_at: "2026-06-20T00:00:00.000Z",
      }),
      sender: { login: "owner", type: "User" },
    });
    const eval_ = await reviewAuditRows(env, "pr_outcome");
    expect(eval_).toHaveLength(1);
    expect(eval_[0]).toMatchObject({
      project: "owner/repo",
      target_id: "owner/repo#42",
      decision: "merged",
    });
    const ledger = await auditEventRows(env, "pr_outcome");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      target_key: "owner/repo#42",
      detail: "merged",
    });
  });

  it("writes a pr_outcome=closed row when a maintainer closes a PR WITHOUT merging", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 43,
        merged_at: null,
        user: { login: "contributor", type: "User" },
      }),
      sender: { login: "owner", type: "User" },
    });
    expect((await reviewAuditRows(env, "pr_outcome"))[0]).toMatchObject({
      target_id: "owner/repo#43",
      decision: "closed",
    });
    expect((await auditEventRows(env, "pr_outcome"))[0]).toMatchObject({
      detail: "closed",
    });
  });

  it("writes a pr_outcome=closed row when LoopOver (a bot) closes a PR", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 44,
        merged_at: null,
        user: { login: "contributor", type: "User" },
      }),
      sender: { login: "loopover-orb[bot]", type: "Bot" },
    });
    expect((await reviewAuditRows(env, "pr_outcome"))[0]).toMatchObject({
      target_id: "owner/repo#44",
      decision: "closed",
    });
    expect((await auditEventRows(env, "pr_outcome"))[0]).toMatchObject({
      detail: "closed",
    });
  });

  it("REGRESSION: does not send a duplicate Discord notification from the pull_request.closed outcome webhook", async () => {
    const env = Object.assign(createTestEnv(), { DISCORD_REPO_WEBHOOKS: JSON.stringify({ "owner/repo": "https://discord.com/api/webhooks/repo/token" }) }) as Env;
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 44,
        merged_at: null,
        user: { login: "contributor", type: "User" },
      }),
      sender: { login: "loopover-orb[bot]", type: "Bot" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await reviewAuditRows(env, "pr_outcome"))[0]).toMatchObject({
      target_id: "owner/repo#44",
      decision: "closed",
    });
  });

  it("records NOTHING for an unmerged contributor PR self-close", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 43,
        merged_at: null,
        user: { login: "contributor", type: "User" },
      }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "pr_outcome")).toHaveLength(0);
    expect(await auditEventRows(env, "pr_outcome")).toHaveLength(0);
  });

  it("records NOTHING for a non-closed action or a payload with no PR number", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", {
      action: "opened",
      repository: { name: "repo", full_name: "owner/repo" },
      pull_request: pullRequestPayload({ number: 44, state: "open" }),
    });
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: { name: "repo", full_name: "owner/repo" },
    });
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
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "contributor", type: "User" }, // not the owner, not a bot → a genuine dispute
    });
    const eval_ = await reviewAuditRows(env, "reversal_reopened");
    expect(eval_).toHaveLength(1);
    expect(eval_[0]).toMatchObject({
      project: "owner/repo",
      target_id: "owner/repo#7",
    });
    expect(await auditEventRows(env, "reversal_reopened")).toHaveLength(1);
  });

  it("does NOT record when the last bot action on the PR was NOT a close (e.g. merge/approve)", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "approve");
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
  });

  it("does NOT immediately record an OWNER reopen (still ambiguous on its own — #7985), and never records a BOT reopen at all", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "close");
    // Owner reopen — a bare reopen alone stays ambiguous (could be an administrative re-queue); it only
    // becomes a reversal if a merge follows within the window (see the describe block below).
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "owner", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
    // ...but it DOES record the time-bounded pending marker the merge branch will look for.
    expect(await auditEventRows(env, "owner_reopen_pending_reversal")).toHaveLength(1);

    // Bot reopen — not a human dispute, no marker at all.
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "some-bot[bot]", type: "Bot" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
    expect(await auditEventRows(env, "owner_reopen_pending_reversal")).toHaveLength(1); // unchanged
  });

  describe("owner reopen + merge within the window (#7985)", () => {
    it("promotes an owner's reopen-then-merge of a bot-closed PR to a real reversal_reopened", async () => {
      const env = createTestEnv();
      await seedBotAction(env, "owner/repo#7", "close");
      await recordReversalSignals(env, "pull_request", {
        action: "reopened",
        repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
        pull_request: pullRequestPayload({ number: 7, state: "open" }),
        sender: { login: "owner", type: "User" },
      });
      expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0); // not yet — no merge seen
      await recordReversalSignals(env, "pull_request", {
        action: "closed",
        repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
        pull_request: pullRequestPayload({ number: 7, merged_at: "2026-06-20T00:00:00.000Z" }),
        sender: { login: "owner", type: "User" },
      });
      const eval_ = await reviewAuditRows(env, "reversal_reopened");
      expect(eval_).toHaveLength(1);
      expect(eval_[0]).toMatchObject({ project: "owner/repo", target_id: "owner/repo#7" });
      expect(await auditEventRows(env, "reversal_reopened")).toHaveLength(1);
    });

    it("does NOT record a reversal for a plain merge with no preceding owner-reopen marker", async () => {
      const env = createTestEnv();
      await recordReversalSignals(env, "pull_request", {
        action: "closed",
        repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
        pull_request: pullRequestPayload({ number: 7, merged_at: "2026-06-20T00:00:00.000Z" }),
        sender: { login: "owner", type: "User" },
      });
      expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
    });

    it("does NOT record a reversal when the owner-reopen marker is older than the merge window (stale rescue signal)", async () => {
      const env = createTestEnv();
      await seedBotAction(env, "owner/repo#7", "close");
      // Seed a marker far enough in the past that it's outside OWNER_REOPEN_MERGE_WINDOW_MS by construction,
      // bypassing recordReversalSignals' own (real-clock) write path so the test isn't time-flaky.
      await recordAuditEvent(env, {
        eventType: "owner_reopen_pending_reversal",
        actor: "owner",
        targetKey: "owner/repo#7",
        outcome: "completed",
        detail: "Bot-closed PR #7 reopened by the repo owner.",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      await recordReversalSignals(env, "pull_request", {
        action: "closed",
        repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
        pull_request: pullRequestPayload({ number: 7, merged_at: "2026-06-20T00:00:00.000Z" }),
        sender: { login: "owner", type: "User" },
      });
      expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
    });

    it("does NOT record a reversal when the owner reopens a PR whose last bot action was NOT a close", async () => {
      const env = createTestEnv();
      await seedBotAction(env, "owner/repo#7", "approve");
      await recordReversalSignals(env, "pull_request", {
        action: "reopened",
        repository: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
        pull_request: pullRequestPayload({ number: 7, state: "open" }),
        sender: { login: "owner", type: "User" },
      });
      expect(await auditEventRows(env, "owner_reopen_pending_reversal")).toHaveLength(0);
    });
  });

  it("still records reversal_reopened when the bot close was logged with the legacy 'success' outcome", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "close", "success");
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(1);
  });

  it("does NOT record reversal_reopened when the latest bot close was only a dry-run shadow", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "close", "completed", "dry_run");
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(0);
    expect(await auditEventRows(env, "reversal_reopened")).toHaveLength(0);
  });

  it("still records reversal_reopened when the latest bot close was completed in live mode", async () => {
    const env = createTestEnv();
    await seedBotAction(env, "owner/repo#7", "close", "completed", "live");
    await recordReversalSignals(env, "pull_request", {
      action: "reopened",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({ number: 7, state: "open" }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reopened")).toHaveLength(1);
  });

  it('records reversal_reverted against PR #N for a merged "Reverts #N" PR — when #N\'s merge was recorded', async () => {
    const env = createTestEnv();
    // Corroboration: our ledger must have observed PR #50 merge first.
    await recordPrOutcome(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 50,
        merged_at: "2026-06-19T00:00:00.000Z",
      }),
      sender: { login: "owner", type: "User" },
    });
    await recordReversalSignals(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 99,
        merged_at: "2026-06-20T00:00:00.000Z",
        body: "Reverts #50\n\nThis reverts the change.",
      }),
      sender: { login: "contributor", type: "User" },
    });
    const eval_ = await reviewAuditRows(env, "reversal_reverted");
    expect(eval_).toHaveLength(1);
    expect(eval_[0]).toMatchObject({ target_id: "owner/repo#50" });
    expect(await auditEventRows(env, "reversal_reverted")).toHaveLength(1);
  });

  it("does NOT record reversal_reverted when the cited PR #N has no recorded merge (anti-forgery, #audit-3.2)", async () => {
    const env = createTestEnv();
    // No pr_outcome=merged recorded for #50 → a contributor's merged \"Reverts #50\" must not forge a reversal.
    await recordReversalSignals(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 99,
        merged_at: "2026-06-20T00:00:00.000Z",
        body: "Reverts #50\n\nThis reverts the change.",
      }),
      sender: { login: "contributor", type: "User" },
    });
    expect(await reviewAuditRows(env, "reversal_reverted")).toHaveLength(0);
    expect(await auditEventRows(env, "reversal_reverted")).toHaveLength(0);
  });

  it("is fail-safe when the corroboration read throws — records nothing without throwing", async () => {
    const env = createTestEnv();
    const broken = { ...env, DB: null } as unknown as typeof env; // wasMergeRecorded's read throws → caught → false
    await expect(
      recordReversalSignals(broken, "pull_request", {
        action: "closed",
        repository: {
          name: "repo",
          full_name: "owner/repo",
          owner: { login: "owner" },
        },
        pull_request: pullRequestPayload({
          number: 99,
          merged_at: "2026-06-20T00:00:00.000Z",
          body: "Reverts #50",
        }),
        sender: { login: "contributor", type: "User" },
      }),
    ).resolves.toBeUndefined();
  });

  it("does NOT record reversal_reverted for a merged PR whose body is not a revert", async () => {
    const env = createTestEnv();
    await recordReversalSignals(env, "pull_request", {
      action: "closed",
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: pullRequestPayload({
        number: 99,
        merged_at: "2026-06-20T00:00:00.000Z",
        body: "A normal feature PR.",
      }),
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
  const mergeAction: PlannedAgentAction = {
    actionClass: "merge",
    requiresApproval: false,
    reason: "ready",
  };
  const readyLabel: PlannedAgentAction = {
    actionClass: "label",
    requiresApproval: false,
    reason: "ready",
    label: AGENT_LABEL_READY,
    labelOp: "add",
  };
  const closeAction: PlannedAgentAction = {
    actionClass: "close",
    requiresApproval: false,
    reason: "bad",
  };

  it("holdOnly=false → returns the plan UNCHANGED (byte-identical common path)", () => {
    const plan = [readyLabel, mergeAction];
    expect(downgradeMergeToHold(plan, false)).toBe(plan);
  });

  it("holdOnly=true + a planned merge → drops the merge + ready label, adds manual-review", () => {
    const out = downgradeMergeToHold([readyLabel, mergeAction], true);
    expect(out.some((a) => a.actionClass === "merge")).toBe(false);
    expect(
      out.some(
        (a) =>
              a.actionClass === "label" && a.label === AGENT_LABEL_READY,
      ),
    ).toBe(false);
    expect(
      out.some(
        (a) =>
          a.actionClass === "label" &&
          a.label === AGENT_LABEL_NEEDS_REVIEW &&
          a.labelOp === "add",
      ),
    ).toBe(true);
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

  it("enforces a miner-scoped holdonly flag only for confirmed miner-authored PRs", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    await flags.setFlag("holdonly:owner/repo:miner", true);

    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
    expect(await isHoldOnly(env, "owner/repo", false)).toBe(false);
    expect(await isHoldOnly(env, "owner/repo", true)).toBe(true);
    expect(await isHoldOnly(env, "owner/other", true)).toBe(false);
  });

  it("flagSetAt round-trips the updated_at and is null when unset", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    expect(await flags.flagSetAt("holdonly:owner/repo")).toBeNull();
    await flags.setFlag("holdonly:owner/repo", true);
    expect(await flags.flagSetAt("holdonly:owner/repo")).toBeTruthy();
  });
});

describe("isCloseHoldOnly + createFlagStore.isCloseHoldOnly (closehold:<scope>, same system_flags table)", () => {
  it("isCloseHoldOnly is false with no flags, true once closehold:<project> is set, with per-project isolation, and respects closehold:global", async () => {
    const env = createTestEnv();
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
    const flags = createFlagStore(env);
    await flags.setFlag("closehold:owner/repo", true);
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(true);
    expect(await isCloseHoldOnly(env, "owner/other")).toBe(false); // per-project isolation
    // the merge breaker is independent: a closehold does NOT set holdonly.
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
    await flags.setFlag("closehold:owner/repo", false);
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
    // global close breaker applies to every project.
    await flags.setFlag("closehold:global", true);
    expect(await isCloseHoldOnly(env, "any/repo")).toBe(true);
  });

  it("enforces a miner-scoped closehold flag only for confirmed miner-authored PRs", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    await flags.setFlag("closehold:owner/repo:miner", true);

    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
    expect(await isCloseHoldOnly(env, "owner/repo", false)).toBe(false);
    expect(await isCloseHoldOnly(env, "owner/repo", true)).toBe(true);
    expect(await isCloseHoldOnly(env, "owner/other", true)).toBe(false);
  });

  it("createFlagStore.isCloseHoldOnly reads the per-project closehold key (not the global one)", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    expect(await flags.isCloseHoldOnly("owner/repo")).toBe(false);
    await flags.setFlag("closehold:owner/repo", true);
    expect(await flags.isCloseHoldOnly("owner/repo")).toBe(true);
    expect(await flags.isCloseHoldOnly("owner/other")).toBe(false);
    // The per-key store read does NOT fold in the global flag (mirrors isHoldOnly's per-key dedup read).
    await flags.setFlag("closehold:owner/repo", false);
    await flags.setFlag("closehold:global", true);
    expect(await flags.isCloseHoldOnly("owner/repo")).toBe(false);
  });

  it("isCloseHoldOnly ignores a closehold row whose value is falsy (flagTruthy false arm)", async () => {
    const env = createTestEnv();
    // A row exists for this project but its value is '0' (not truthy) → must NOT count as engaged.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES ('closehold:owner/repo', '0', CURRENT_TIMESTAMP)",
    ).run();
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("isCloseHoldOnly tolerates an all() result with no `results` array (the ?? [] fallback arm)", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      // Force the system_flags scan to return an object WITHOUT a `results` array so `res.results ?? []` falls back.
      if (/SELECT key, value FROM system_flags/i.test(sql)) {
        return { all: async () => ({}) } as unknown as ReturnType<
          typeof realPrepare
        >;
      }
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false); // no rows → not engaged, no throw
  });

  it("createFlagStore.isCloseHoldOnly fails safe (returns false) when the store read throws", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/system_flags/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const flags = createFlagStore(env);
    expect(await flags.isCloseHoldOnly("owner/repo")).toBe(false); // catch arm → false, never throws
  });

  it("isCloseHoldOnly (env-level) fails OPEN (false) and logs flags_read_error when the scan throws", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/system_flags/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("flags_read_error"),
    );
    warn.mockRestore();
  });
});

describe("applyAutoTune over the live FlagStore — engages holdonly on low merge precision", () => {
  it("engages holdonly:<project> when merge precision is below the floor over a real sample", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    // 5 confirmed / 12 would-merge = ~42% precision over 12 decided → below the 85% floor with a real sample.
    const report: GateEvalReport = {
      rows: [
        {
          project: "owner/repo",
          wouldMerge: 12,
          mergeConfirmed: 5,
          mergeFalse: 7,
          wouldClose: 0,
          closeConfirmed: 0,
          closeFalse: 0,
          hold: 0,
          decided: 12,
          mergePrecision: 5 / 12,
          closePrecision: null,
          // #2348: no reversal scenario in this fixture — weighted mirrors raw.
          weightedMergeConfirmed: 5,
          weightedCloseConfirmed: 0,
          weightedMergePrecision: 5 / 12,
          weightedClosePrecision: null,
        },
      ],
      hasSignal: true,
    };
    const engaged = await applyAutoTune(flags, report);
    expect(engaged.map((a) => a.project)).toEqual(["owner/repo"]);
    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
  });
});

describe("runSelfTuneBreaker — reads recorded pr_outcome ground truth + engages/clears the breaker", () => {
  // Seed a gate_decision prediction + the realized pr_outcome for one PR (the join computeGateEval folds).
  async function seedDecisionAndOutcome(
    env: Env,
    project: string,
    pr: number,
    pred: "merge" | "close",
    truth: "merged" | "closed",
  ): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'gate_decision', ?, 'gittensory-native', ?, NULL, CURRENT_TIMESTAMP)",
    )
      .bind(
        `gd:${project}#${pr}`,
        project,
        `${project}#${pr}`,
        pred,
        `sha${pr}`,
      )
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
    for (let i = 0; i < 4; i += 1)
      await seedDecisionAndOutcome(env, "owner/repo", i, "merge", "merged");
    for (let i = 4; i < 12; i += 1)
      await seedDecisionAndOutcome(env, "owner/repo", i, "merge", "closed");

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSelfTuneBreaker(env);

    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
    // The bot self-disabling its own auto-merge now surfaces to Sentry at error level (not a hidden warn).
    expect(err.mock.calls.some(([l]) => String(l).includes("breaker_engaged") && String(l).includes('"level":"error"'))).toBe(true);
    err.mockRestore();
  });

  it("ENGAGES the CLOSE breaker when recorded outcomes show close precision below the floor", async () => {
    const env = createTestEnv();
    // 12 would-CLOSE predictions: 4 confirmed (human closed), 8 the human actually MERGED → 33% close precision.
    for (let i = 0; i < 4; i += 1)
      await seedDecisionAndOutcome(env, "owner/repo", i, "close", "closed");
    for (let i = 4; i < 12; i += 1)
      await seedDecisionAndOutcome(env, "owner/repo", i, "close", "merged");

    await runSelfTuneBreaker(env);

    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(true);
    // The merge breaker is INDEPENDENT — close-precision failure must not engage holdonly.
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("does NOT engage the CLOSE breaker when recorded close precision is healthy", async () => {
    const env = createTestEnv();
    // 12 would-CLOSE predictions: 12 confirmed (human closed) → 100% close precision, well above the floor.
    for (let i = 0; i < 12; i += 1)
      await seedDecisionAndOutcome(env, "owner/repo", i, "close", "closed");

    await runSelfTuneBreaker(env);

    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("does NOT engage with no recorded outcome history (fail-safe / byte-identical — both breakers)", async () => {
    const env = createTestEnv();
    await runSelfTuneBreaker(env);
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("AUTO-CLEARS both breakers once the cooldown has elapsed AND precision recovered", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    // Engage both breakers directly, then backdate their updated_at past the 24h cooldown.
    await flags.setFlag("holdonly:owner/repo", true);
    await flags.setFlag("closehold:owner/repo", true);
    await env.DB.prepare(
      "UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key IN ('holdonly:owner/repo', 'closehold:owner/repo')",
    ).run();
    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(true);
    // Seed RECOVERED outcomes for both directions: every merge prediction merged, every close prediction closed.
    for (let i = 0; i < 12; i += 1)
      await seedDecisionAndOutcome(env, "owner/repo", i, "merge", "merged");
    for (let i = 12; i < 24; i += 1)
      await seedDecisionAndOutcome(env, "owner/repo", i, "close", "closed");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSelfTuneBreaker(env);
    log.mockRestore();

    expect(await isHoldOnly(env, "owner/repo")).toBe(false); // merge breaker auto-cleared
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false); // close breaker auto-cleared
  });

  describe("#6803: review.selftune: false opt-out is absolute for the breaker too, not just the routine tuning pass", () => {
    it("does NOT engage the merge or close breaker for an opted-out repo, even with data that would otherwise trip both", async () => {
      const env = createTestEnv();
      await upsertRepoFocusManifest(env, "owner/opted-out", { review: { selftune: false } });
      // Same shape as the plain ENGAGES tests above -- would trip both breakers if this repo weren't opted out.
      for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcome(env, "owner/opted-out", i, "merge", "merged");
      for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcome(env, "owner/opted-out", i, "merge", "closed");
      for (let i = 12; i < 16; i += 1) await seedDecisionAndOutcome(env, "owner/opted-out", i, "close", "closed");
      for (let i = 16; i < 24; i += 1) await seedDecisionAndOutcome(env, "owner/opted-out", i, "close", "merged");

      await runSelfTuneBreaker(env);

      expect(await isHoldOnly(env, "owner/opted-out")).toBe(false);
      expect(await isCloseHoldOnly(env, "owner/opted-out")).toBe(false);
    });

    it("does NOT auto-clear an already-engaged flag for an opted-out repo, even with fully recovered precision -- the opt-out is absolute, not one-directional", async () => {
      const env = createTestEnv();
      const flags = createFlagStore(env);
      await flags.setFlag("holdonly:owner/opted-out", true);
      await flags.setFlag("closehold:owner/opted-out", true);
      await env.DB.prepare(
        "UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key IN ('holdonly:owner/opted-out', 'closehold:owner/opted-out')",
      ).run();
      await upsertRepoFocusManifest(env, "owner/opted-out", { review: { selftune: false } });
      // Fully recovered precision -- would auto-clear both breakers (per the AUTO-CLEARS test above) if this
      // repo weren't opted out.
      for (let i = 0; i < 12; i += 1) await seedDecisionAndOutcome(env, "owner/opted-out", i, "merge", "merged");
      for (let i = 12; i < 24; i += 1) await seedDecisionAndOutcome(env, "owner/opted-out", i, "close", "closed");

      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await runSelfTuneBreaker(env);
      log.mockRestore();

      expect(await isHoldOnly(env, "owner/opted-out")).toBe(true);
      expect(await isCloseHoldOnly(env, "owner/opted-out")).toBe(true);
    });

    it("also excludes an opted-out repo from the miner-scoped pass (#2352)", async () => {
      const env = createTestEnv();
      await upsertRepoFocusManifest(env, "owner/opted-out", { review: { selftune: false } });
      // Miner-authored rows (miner_authored=1), same shape as the #2352 ENGAGES test: 33% precision, would
      // otherwise trip the holdonly:owner/opted-out:miner flag.
      for (let i = 0; i < 4; i += 1) {
        await env.DB.prepare(
          "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, miner_authored, created_at) VALUES (?, ?, ?, 'gate_decision', 'merge', 'gittensory-native', ?, NULL, 1, CURRENT_TIMESTAMP)",
        )
          .bind(`gd:m:owner/opted-out#${i}`, "owner/opted-out", `owner/opted-out#${i}`, `sha${i}`)
          .run();
        await env.DB.prepare(
          "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'pr_outcome', 'merged', 'gittensory-native', NULL, NULL, CURRENT_TIMESTAMP)",
        )
          .bind(`po:m:owner/opted-out#${i}`, "owner/opted-out", `owner/opted-out#${i}`)
          .run();
      }
      for (let i = 4; i < 12; i += 1) {
        await env.DB.prepare(
          "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, miner_authored, created_at) VALUES (?, ?, ?, 'gate_decision', 'merge', 'gittensory-native', ?, NULL, 1, CURRENT_TIMESTAMP)",
        )
          .bind(`gd:m:owner/opted-out#${i}`, "owner/opted-out", `owner/opted-out#${i}`, `sha${i}`)
          .run();
        await env.DB.prepare(
          "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'pr_outcome', 'closed', 'gittensory-native', NULL, NULL, CURRENT_TIMESTAMP)",
        )
          .bind(`po:m:owner/opted-out#${i}`, "owner/opted-out", `owner/opted-out#${i}`)
          .run();
      }

      await runSelfTuneBreaker(env);

      expect(await isHoldOnly(env, "owner/opted-out:miner")).toBe(false);
    });

    it("does not opt out an unrelated repo (the exclusion is per-repo, not global)", async () => {
      const env = createTestEnv();
      await upsertRepoFocusManifest(env, "owner/opted-out", { review: { selftune: false } });
      for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcome(env, "owner/still-tuned", i, "merge", "merged");
      for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcome(env, "owner/still-tuned", i, "merge", "closed");

      await runSelfTuneBreaker(env);

      expect(await isHoldOnly(env, "owner/still-tuned")).toBe(true);
    });
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

  // Seed a gate_decision/pr_outcome pair under an ARBITRARY source (e.g. the pre-convergence 'reviewbot'
  // engine), independent of the gittensory-native-only seedDecisionAndOutcome helper above.
  async function seedDecisionAndOutcomeForSource(env: Env, project: string, pr: number, pred: "merge" | "close", truth: "merged" | "closed", source: string): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'gate_decision', ?, ?, ?, NULL, CURRENT_TIMESTAMP)",
    )
      .bind(`gd:${source}:${project}#${pr}`, project, `${project}#${pr}`, pred, source, `sha${pr}`)
      .run();
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'pr_outcome', ?, ?, NULL, NULL, CURRENT_TIMESTAMP)",
    )
      .bind(`po:${source}:${project}#${pr}`, project, `${project}#${pr}`, truth, source)
      .run();
  }

  it("#autoclear-deadlock (stale-source): a FROZEN legacy 'reviewbot' close-precision failure does NOT engage the LIVE close breaker — the tick is scoped to source='gittensory-native'", async () => {
    const env = createTestEnv();
    // 12 would-CLOSE predictions from the pre-convergence 'reviewbot' engine, 33% precision — would trip the
    // floor if read, but this source stopped writing long ago and must not drive the LIVE self-host breaker.
    for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcomeForSource(env, "owner/repo", i, "close", "closed", "reviewbot");
    for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcomeForSource(env, "owner/repo", i, "close", "merged", "reviewbot");

    await runSelfTuneBreaker(env);

    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("#autoclear-deadlock: a per-project closehold flag with NO fresh gittensory-native decided sample (report.rows empty for it) still auto-clears once the cooldown elapses", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    // Engage the CLOSE breaker directly (as the auto-tuner would have) and backdate past the 24h cooldown.
    await flags.setFlag("closehold:owner/repo", true);
    await env.DB.prepare("UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key = 'closehold:owner/repo'").run();
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(true);
    // No gittensory-native gate_decision/pr_outcome rows are seeded at all for this project — pre-fix, the
    // auto-clear loop only walked report.rows and would never reconsider a project with zero decided samples,
    // stranding the flag engaged forever regardless of the cooldown.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSelfTuneBreaker(env);
    log.mockRestore();

    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("#autoclear-deadlock: does NOT auto-clear a stranded closehold flag before its cooldown has elapsed", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    await flags.setFlag("closehold:owner/repo", true); // freshly engaged (updated_at = now) — still within cooldown
    await runSelfTuneBreaker(env);
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(true);
  });

  it("#autoclear-deadlock: a human-set GLOBAL closehold flag is never entered into the widened auto-clear candidate set", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    await flags.setFlag("closehold:global", true);
    await env.DB.prepare("UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key = 'closehold:global'").run();
    await runSelfTuneBreaker(env);
    // The global scope stays a human-only clear — the cooldown-elapsed widening must never touch it.
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(true);
  });

  it("#autoclear-deadlock: the merge-side holdonly flag gets the same widened-candidate auto-clear treatment", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    await flags.setFlag("holdonly:owner/repo", true);
    await env.DB.prepare("UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key = 'holdonly:owner/repo'").run();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSelfTuneBreaker(env);
    log.mockRestore();
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("#autoclear-deadlock: a holdonly/closehold row with a falsy value is excluded from the widened candidate set (flagTruthy false arm)", async () => {
    const env = createTestEnv();
    // A stray row exists but is NOT truthy — must not be treated as an engaged breaker (would otherwise call
    // maybeAutoClear* for a project that was never really engaged).
    await env.DB.prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES ('closehold:owner/repo', '0', CURRENT_TIMESTAMP)").run();
    await expect(runSelfTuneBreaker(env)).resolves.toBeUndefined();
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("#autoclear-deadlock: tolerates an all() result with no `results` array when scanning for engaged scopes (the ?? [] fallback arm)", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/SELECT key, value FROM system_flags WHERE key LIKE/i.test(sql)) {
        return { all: async () => ({}) } as unknown as ReturnType<typeof realPrepare>;
      }
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    await expect(runSelfTuneBreaker(env)).resolves.toBeUndefined();
  });

  it("#autoclear-deadlock: fails safe (empty candidate widening) when the engaged-scopes scan throws, without breaking the tick", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    await flags.setFlag("closehold:owner/repo", true);
    await env.DB.prepare("UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key = 'closehold:owner/repo'").run();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/SELECT key, value FROM system_flags WHERE key LIKE/i.test(sql)) throw new Error("d1 down");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runSelfTuneBreaker(env)).resolves.toBeUndefined();
    warn.mockRestore();
    // The scan failed, so the widened candidate set fell back to report.rows alone (empty here) — the flag,
    // with no fresh decided sample either, is correctly left engaged rather than incorrectly cleared.
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(true);
  });
});

// ── #2352: the miner-scoped breaker pass, independent of the existing human/mixed-population one ──────────────

describe("runSelfTuneBreaker — miner-scoped breaker (#2352)", () => {
  async function seedDecisionAndOutcomeScoped(
    env: Env,
    project: string,
    pr: number,
    pred: "merge" | "close",
    truth: "merged" | "closed",
    minerAuthored: boolean,
  ): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, miner_authored, created_at) VALUES (?, ?, ?, 'gate_decision', ?, 'gittensory-native', ?, NULL, ?, CURRENT_TIMESTAMP)",
    )
      .bind(`gd:${minerAuthored ? "m" : "h"}:${project}#${pr}`, project, `${project}#${pr}`, pred, `sha${pr}`, minerAuthored ? 1 : 0)
      .run();
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?, ?, ?, 'pr_outcome', ?, 'gittensory-native', NULL, NULL, CURRENT_TIMESTAMP)",
    )
      .bind(`po:${minerAuthored ? "m" : "h"}:${project}#${pr}`, project, `${project}#${pr}`, truth)
      .run();
  }

  // IMPORTANT (all scenarios below): the EXISTING/unscoped `report` pass is NOT disjoint from miner-authored
  // data — it is `source='gittensory-native'` with NO miner_authored filter, so it counts EVERY prediction for
  // a project, miner-authored or not (preserving that pass's existing, unchanged meaning: overall accuracy).
  // Only the SEPARATE `minerOnly` pass excludes non-miner rows. So a project's miner-authored rows are counted
  // TWICE — once in the mixed/unscoped population, once in the miner-only subset — and demonstrating "engages
  // one scope but not the other" requires enough volume on the healthy side to keep the MIXED population's
  // precision on the opposite side of the floor from the SUBSET's precision.

  it("ENGAGES the miner-scoped holdonly flag (holdonly:<project>:miner) when miner-authored predictions show low merge precision, while the human-scoped flag for the SAME project stays clear", async () => {
    const env = createTestEnv();
    // Miner-authored: 12 would-merge, only 4 confirmed → 33% precision, below the floor.
    for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", true);
    for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "closed", true);
    // Human-authored, SAME project: 50 would-merge, all confirmed. Diluted into the MIXED population: (4+50) /
    // (12+50) = 87.1%, above the floor — the mixed/unscoped pass reads healthy even though the miner SUBSET
    // (4/12 = 33%) does not.
    for (let i = 100; i < 150; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", false);

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSelfTuneBreaker(env);

    expect(await isHoldOnly(env, "owner/repo:miner")).toBe(true);
    expect(await isHoldOnly(env, "owner/repo")).toBe(false);
    expect(err.mock.calls.some(([l]) => String(l).includes('"event":"miner_breaker_engaged"') && String(l).includes('"project":"owner/repo:miner"'))).toBe(true);
    err.mockRestore();
  });

  it("does NOT engage the miner-scoped flag when the mixed population is only dragged down by NON-miner rows — the leak #2352 exists to prevent, in the other direction", async () => {
    const env = createTestEnv();
    // Human-authored: 12 would-merge, only 4 confirmed → 33% precision — drags the MIXED population's precision
    // down (there is no dilution on this side: this IS the whole non-miner population).
    for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", false);
    for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "closed", false);
    // Miner-authored, SAME project: perfectly healthy on its own (the miner-only SUBSET reads 100%).
    for (let i = 100; i < 112; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", true);

    await runSelfTuneBreaker(env);

    // Mixed: (4+12)/(12+12) = 66.7% < floor → the existing, unscoped breaker still fires (unchanged invariant).
    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
    // Miner-only subset: 12/12 = 100% >= floor → must NOT engage just because the MIXED population is unhealthy.
    expect(await isHoldOnly(env, "owner/repo:miner")).toBe(false);
  });

  it("ENGAGES the miner-scoped CLOSE breaker (closehold:<project>:miner) independently of the human-scoped close breaker", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "close", "closed", true);
    for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "close", "merged", true);
    // Dilute the mixed population with healthy non-miner close predictions, same ratio as the merge scenario.
    for (let i = 100; i < 150; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "close", "closed", false);

    await runSelfTuneBreaker(env);

    expect(await isCloseHoldOnly(env, "owner/repo:miner")).toBe(true);
    expect(await isCloseHoldOnly(env, "owner/repo")).toBe(false);
  });

  it("clearing the human-scoped holdonly flag does NOT clear the miner-scoped one, and vice versa — they are genuinely distinct flags", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    // Engage BOTH scopes directly, then backdate both past the 24h cooldown.
    await flags.setFlag("holdonly:owner/repo", true);
    await flags.setFlag("holdonly:owner/repo:miner", true);
    await env.DB.prepare(
      "UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key IN ('holdonly:owner/repo', 'holdonly:owner/repo:miner')",
    ).run();
    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
    expect(await isHoldOnly(env, "owner/repo:miner")).toBe(true);

    // Miner-authored stays genuinely failing (4/12 = 33%). Enough healthy non-miner volume dilutes the MIXED
    // population back above the floor ((4+50)/(12+50) = 87.1%) so the unscoped flag recovers, while the
    // miner-only SUBSET (still 33%) does not.
    for (let i = 0; i < 4; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", true);
    for (let i = 4; i < 12; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "closed", true);
    for (let i = 100; i < 150; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", false);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSelfTuneBreaker(env);
    log.mockRestore();

    expect(await isHoldOnly(env, "owner/repo")).toBe(false); // human/mixed-scoped: recovered → auto-cleared
    expect(await isHoldOnly(env, "owner/repo:miner")).toBe(true); // miner-scoped: still failing → stays engaged
  });

  it("the miner-scoped flag auto-clears independently once ITS cooldown elapses and ITS precision recovers, while a still-engaged (still genuinely failing) mixed-scoped flag is untouched", async () => {
    const env = createTestEnv();
    const flags = createFlagStore(env);
    await flags.setFlag("holdonly:owner/repo", true);
    await flags.setFlag("holdonly:owner/repo:miner", true);
    await env.DB.prepare(
      "UPDATE system_flags SET updated_at = datetime('now', '-2 days') WHERE key IN ('holdonly:owner/repo', 'holdonly:owner/repo:miner')",
    ).run();

    // Miner-authored fully recovers (12/12 = 100%). Non-miner data for the SAME project stays genuinely bad
    // (4/12 = 33%) — with no dilution on that side, the MIXED population is (12+4)/(12+12) = 66.7%, still below
    // the floor, so the mixed/unscoped flag correctly stays engaged (this is a REAL still-failing population,
    // not merely "no fresh sample" — a stronger claim than the existing #autoclear-deadlock "no signal" case).
    for (let i = 0; i < 12; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", true);
    for (let i = 100; i < 104; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "merged", false);
    for (let i = 104; i < 112; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "closed", false);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSelfTuneBreaker(env);
    log.mockRestore();

    expect(await isHoldOnly(env, "owner/repo:miner")).toBe(false);
    expect(await isHoldOnly(env, "owner/repo")).toBe(true);
  });

  it("does NOT engage the miner-scoped breaker with no miner-authored history at all (fail-safe / byte-identical)", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 12; i += 1) await seedDecisionAndOutcomeScoped(env, "owner/repo", i, "merge", "closed", false);

    await runSelfTuneBreaker(env);

    expect(await isHoldOnly(env, "owner/repo:miner")).toBe(false);
  });
});

// ── integration: the PR-closed webhook records pr_outcome through processJob ────────────────────────────────────

describe("processJob(github-webhook) wires pr_outcome recording on a PR close", () => {
  it("a closed+merged pull_request webhook records the pr_outcome ground truth", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
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
          installation: {
            id: 123,
            account: { login: "JSONbored", id: 1, type: "User" },
          },
          repository: {
            name: "gittensory",
            full_name: "JSONbored/gittensory",
            private: true,
            owner: { login: "JSONbored" },
          },
          pull_request: {
            number: 5151,
            title: "Merged PR",
            state: "closed",
            merged_at: "2026-06-20T00:00:00.000Z",
            user: { login: "contributor" },
            head: { sha: "abc123" },
            labels: [],
            body: "Adds a feature.",
          },
          sender: { login: "contributor", type: "User" },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const eval_ = await reviewAuditRows(env, "pr_outcome");
    expect(
      eval_.some(
        (r) =>
          r.target_id === "JSONbored/gittensory#5151" &&
          r.decision === "merged",
      ),
    ).toBe(true);
  });
});

describe("resolveDispositionReason (enriched Discord reason)", () => {
  it("returns the latest recorded gate verdict summary for the PR", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "g1",
        "owner/repo",
        "owner/repo#7",
        "gate_decision",
        "close",
        "gittensory-native",
        "sha1",
        "older verdict",
        "2026-06-20T00:00:00.000Z",
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "g2",
        "owner/repo",
        "owner/repo#7",
        "gate_decision",
        "close",
        "gittensory-native",
        "sha2",
        "An AI reviewer flagged a likely blocking defect",
        "2026-06-21T00:00:00.000Z",
      )
      .run();
    expect(
      await resolveDispositionReason(env, "owner/repo#7", "fallback"),
    ).toBe("An AI reviewer flagged a likely blocking defect");
  });
  it("falls back when no gate verdict is recorded for the PR", async () => {
    const env = createTestEnv();
    expect(
      await resolveDispositionReason(
        env,
        "owner/repo#999",
        "Pull request merged into the base branch.",
      ),
    ).toBe("Pull request merged into the base branch.");
  });
  it("falls back when the read throws", async () => {
    const broken = {
      DB: {
        prepare: () => {
          throw new Error("db down");
        },
      },
    } as unknown as Env;
    expect(
      await resolveDispositionReason(broken, "owner/repo#7", "fallback"),
    ).toBe("fallback");
  });
});
