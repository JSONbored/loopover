import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = join(process.cwd(), "packages/gittensory-miner/README.md");

describe("gittensory-miner local storage README (#4272, #4876)", () => {
  it("documents every local SQLite store with file/table/module/env-var", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("## Local storage");
    for (const row of [
      ["laptop-state.sqlite3", "laptop_meta", "laptop-init.js"],
      ["run-state.sqlite3", "miner_run_state", "run-state.js", "GITTENSORY_MINER_RUN_STATE_DB"],
      ["claim-ledger.sqlite3", "miner_claims", "claim-ledger.js", "GITTENSORY_MINER_CLAIM_LEDGER_DB"],
      ["portfolio-queue.sqlite3", "miner_portfolio_queue", "portfolio-queue.js", "GITTENSORY_MINER_PORTFOLIO_QUEUE_DB"],
      ["event-ledger.sqlite3", "miner_event_ledger", "event-ledger.js", "GITTENSORY_MINER_EVENT_LEDGER_DB"],
      ["plan-store.sqlite3", "miner_plans", "plan-store.js", "GITTENSORY_MINER_PLAN_STORE_DB"],
      ["governor-ledger.sqlite3", "governor_events", "governor-ledger.js", "GITTENSORY_MINER_GOVERNOR_LEDGER_DB"],
      ["governor-state.sqlite3", "governor_scalar_state", "governor-state.js", "GITTENSORY_MINER_GOVERNOR_STATE_DB"],
      ["attempt-log.sqlite3", "attempt_log_events", "attempt-log.js", "GITTENSORY_MINER_ATTEMPT_LOG_DB"],
      ["prediction-ledger.sqlite3", "predictions", "prediction-ledger.js", "GITTENSORY_MINER_PREDICTION_LEDGER_DB"],
      ["replay-snapshot.sqlite3", "replay_snapshots", "replay-snapshot.js", "GITTENSORY_MINER_REPLAY_SNAPSHOT_DB"],
      ["deny-hook-synthesis.sqlite3", "deny_rule_proposals", "deny-hook-synthesis.js", "GITTENSORY_MINER_DENY_HOOK_SYNTHESIS_DB"],
      ["worktree-allocator.sqlite3", "worktree_slots", "worktree-allocator.js", "GITTENSORY_MINER_WORKTREE_ALLOCATOR_DB"],
      ["orb-export.sqlite3", "orb_export_meta", "orb-export.js", "GITTENSORY_MINER_ORB_EXPORT_DB"],
      ["policy-doc-cache.sqlite3", "policy_doc_cache", "policy-doc-cache.js", "GITTENSORY_MINER_POLICY_DOC_CACHE_DB"],
      ["policy-verdict-cache.sqlite3", "policy_verdict_cache", "policy-verdict-cache.js", "GITTENSORY_MINER_POLICY_VERDICT_CACHE_DB"],
    ]) {
      for (const token of row) expect(readme).toContain(token);
    }
  });

  it("documents the PR-portfolio read-time-join decision", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("read-time join");
    expect(readme).toContain("manage_pr_update");
  });
});
