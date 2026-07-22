// #4777: retire every gittensory_-prefixed deprecated alias that #4775 left in place for one
// minor-version deprecation cycle. This suite pins the post-retirement shape: exactly the 47
// canonical loopover_-prefixed stdio tools are registered, none of their old gittensory_-prefixed
// alias names resolve anymore, no description carries a stale deprecation notice, and the CLI's
// `tools --json` listing stays in lockstep with what the live server actually registers.
// (#6754 registered the evaluate-escalation mirror, taking the count from 64 to 65.)
// (#// (#6152 registered the 5 maintain-surface tools, taking the count from 42 to 47.)
// (#6150 registered the local-scorer and plan-DAG/predict-gate tools, taking the count from 55 to 60.)
// (#6619 registered the pr-ai-review-findings CLI mirror, taking the count from 60 to 61.)
// (#6621 registered the loopover_get_eligibility_plan REST/CLI mirror, taking the count from 61 to 62.)
// (#6615 registered the loopover_close_pr write-tool — 9th of the 9 buildXSpec builders — taking the count from 62 to 63.)
// (#6732 registered the loopover_monitor_open_prs CLI mirror, taking the count from 63 to 64.)
// (#6752 registered the loopover_build_results_payload CLI mirror, taking the count from 67 to 68.)
// (#6755 registered the loopover_intake_idea CLI mirror, taking the count from 68 to 69.)
// (#6915 registered the loopover_simulate_open_pr_pressure CLI mirror, taking the count from 69 to 70.)
// (#6753 registered the loopover_build_progress_snapshot CLI mirror, taking the count from 70 to 71.)
// (#6942 registered loopover_get_maintainer_lane without bumping this pin — live count became 72.)
// (#6756 registered the loopover_plan_idea_claims CLI mirror, taking the count from 72 to 73.)
// (#6734 registered the loopover_get_repo_outcome_patterns CLI mirror, taking the count from 74 to 75.)
// (#6740 registered the loopover_explain_gate_disposition CLI mirror, taking the count from 75 to 76.)
// (#6741 registered the loopover_draft_pr_body CLI mirror, taking the count from 76 to 77.)
// (#6747 registered the loopover_pr_outcome CLI mirror, taking the count from 77 to 78.)
// (#6980 registered the loopover_explain_review_risk CLI mirror, taking the count from 78 to 79.)
// (#7758 registered the loopover_get_outcome_calibration stdio tool, taking the count from 79 to 80.)
// (#7764 registered the loopover_plan_repo_issues stdio + CLI + REST tool, taking the count from 80 to 81.)
// (#7887 registered loopover_get_activation_preview without bumping this pin — live count became 82.)
// (#7803 registered the loopover_get_registry_snapshot remote+stdio tool, taking the count from 82 to 83.)
// (#7807 registered the loopover_get_upstream_ruleset remote+stdio tool, taking the count from 83 to 84.)
// (#7801 registered the loopover_get_live_gate_thresholds remote+stdio tool, taking the count from 84 to 85.)
// (#7802 registered the loopover_get_pr_maintainer_packet remote+stdio tool, taking the count from 85 to 86.)
// (#7800 registered the loopover_get_gate_config_effective remote+stdio tool, taking the count from 86 to 87.)
// (#7797 registered the loopover_get_ams_miner_cohort remote+stdio tool, taking the count from 87 to 88.)
// (#7808 registered the loopover_get_repo_focus_manifest remote+stdio tool, taking the count from 88 to 89.)
// (#7762 registered the loopover_mark_notifications_read stdio tool, taking the count from 89 to 90.)
// (#7760 registered the loopover_get_contributor_profile stdio tool, taking the count from 90 to 91.)
// (#7763 registered the loopover_watch_issues stdio tool, taking the count from 91 to 92.)
// (#7759 registered the loopover_check_improvement_potential stdio tool, taking the count from 92 to 93.)
// (#7761 registered the loopover_list_notifications stdio tool, taking the count from 93 to 94.)
// (#7752 registered the loopover_get_automation_state stdio tool, taking the count from 94 to 95.)
// (#7757 registered the loopover_get_agent_audit_feed stdio tool, taking the count from 95 to 96.)
// (#7754 registered the loopover_refresh_repo_docs stdio tool, taking the count from 96 to 97.)
// (#7756 registered the loopover_get_repo_onboarding_pack stdio tool, taking the count from 97 to 98.)
// (#7755 registered the loopover_generate_contributor_issue_drafts stdio tool, taking the count from 98 to 99.)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bin,
  closeFixtureServer,
  run,
  startFixtureServer,
} from "./support/mcp-cli-harness";

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect(apiUrl: string) {
  configDir = mkdtempSync(join(tmpdir(), "loopover-rename-alias-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "rename-alias-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("MCP legacy alias retirement (#4777) — discovery invariants", () => {
  beforeEach(async () => {
    const apiUrl = await startFixtureServer();
    await connect(apiUrl);
  });
  afterEach(disconnect);

  it("lists exactly 99 loopover_ tools and zero gittensory_-prefixed aliases", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const primary = names.filter((n) => n.startsWith("loopover_"));
    const legacy = names.filter((n) => n.startsWith("gittensory_"));
    expect(primary.length).toBe(99);
    expect(legacy.length).toBe(0);
    expect(names.length).toBe(99);
  });

  it("no loopover_ tool's description carries a stale deprecation notice", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description ?? "", `${tool.name} description`).not.toMatch(
        /deprecated/i,
      );
    }
  });

  it("`loopover-mcp tools --json` reports the same 99-tool count the live server registers", async () => {
    const { tools } = await client.listTools();
    const payload = JSON.parse(run(["tools", "--json"])) as {
      count: number;
      tools: Array<{ name: string }>;
    };
    expect(payload.count).toBe(tools.length);
    expect(payload.count).toBe(99);
    expect([...payload.tools.map((t) => t.name)].sort()).toEqual(
      [...tools.map((t) => t.name)].sort(),
    );
  });
});

describe("MCP legacy alias retirement (#4777) — old names no longer resolve", () => {
  beforeEach(async () => {
    const apiUrl = await startFixtureServer();
    await connect(apiUrl);
  });
  afterEach(disconnect);

  // Representative sample spanning distinct tool categories (mirrors the pre-retirement suite's
  // coverage): an authenticated API GET proxy, a source-free API POST self-check, a no-argument
  // API GET, an API GET with a path parameter, and pure local logic with no network call.
  const retiredNames = [
    "gittensory_get_repo_context",
    "gittensory_check_slop_risk",
    "gittensory_get_upstream_drift",
    "gittensory_agent_get_run",
    "gittensory_feasibility_gate",
    "gittensory_local_status_structured",
    "gittensory_local_status",
  ];

  it.each(retiredNames)(
    "calling the retired alias %s errors instead of falling through to the handler",
    async (oldName) => {
      const result = await client.callTool({ name: oldName, arguments: {} });
      expect(result.isError).toBe(true);
    },
  );
});
