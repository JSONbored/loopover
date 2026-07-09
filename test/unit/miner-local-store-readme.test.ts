import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = join(process.cwd(), "packages/gittensory-miner/README.md");

describe("gittensory-miner local storage README (#4272)", () => {
  it("documents all four local stores together with their file/table/module/env-var", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("## Local storage");
    expect(readme).toContain("run-state.sqlite3");
    expect(readme).toContain("miner_run_state");
    expect(readme).toContain("claim-ledger.sqlite3");
    expect(readme).toContain("miner_claims");
    expect(readme).toContain("portfolio-queue.sqlite3");
    expect(readme).toContain("miner_portfolio_queue");
    expect(readme).toContain("event-ledger.sqlite3");
    expect(readme).toContain("miner_event_ledger");
    expect(readme).toContain("GITTENSORY_MINER_RUN_STATE_DB");
    expect(readme).toContain("GITTENSORY_MINER_CLAIM_LEDGER_DB");
    expect(readme).toContain("GITTENSORY_MINER_PORTFOLIO_QUEUE_DB");
    expect(readme).toContain("GITTENSORY_MINER_EVENT_LEDGER_DB");
  });

  it("documents the PR-portfolio read-time-join decision", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("read-time join");
    expect(readme).toContain("manage_pr_update");
  });
});
