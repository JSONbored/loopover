import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MINER_KILL_SWITCH_ENV_VAR,
  buildMinerKillSwitchTransitionGovernorLedgerEvent,
  resolveMinerKillSwitch,
} from "../../packages/loopover-engine/src/governor/kill-switch";

const repoRoot = process.cwd();
const runbookPath = join(repoRoot, "apps/loopover-ui/content/docs/ams-kill-switch-incident.mdx");
// #8182 replaced the per-page thin route with the one dynamic docs route — that file now serves this page.
const routePath = join(repoRoot, "apps/loopover-ui/src/routes/docs.$slug.tsx");
const docsNavPath = join(repoRoot, "apps/loopover-ui/src/components/site/docs-nav.tsx");

describe("kill-switch incident runbook (#4809)", () => {
  it("exists as a wired docs page with nav entry", () => {
    const runbook = readFileSync(runbookPath, "utf8");
    const route = readFileSync(routePath, "utf8");
    const nav = readFileSync(docsNavPath, "utf8");

    expect(runbook).toContain("title: Kill-switch incident runbook");
    expect(route).toContain('createFileRoute("/docs/$slug")');
    expect(nav).toContain('to: "/docs/ams-kill-switch-incident"');
  });

  it("pins operator-facing facts to the shipped kill-switch mechanism", () => {
    const runbook = readFileSync(runbookPath, "utf8");

    expect(MINER_KILL_SWITCH_ENV_VAR).toBe("LOOPOVER_MINER_KILL_SWITCH");
    expect(runbook).toContain(MINER_KILL_SWITCH_ENV_VAR);
    expect(runbook).toContain("killSwitch.paused");
    expect(runbook).toContain("kill_switch_engaged");
    expect(runbook).toContain('governor list --type kill_switch');
    expect(runbook).toContain("claim list --repo");
    expect(runbook).toContain("15 minutes");
    expect(runbook).toContain("2 minutes");
    expect(runbook).toContain("#7180");

    expect(resolveMinerKillSwitch({ global: true, repoPaused: true })).toBe("global");
    expect(resolveMinerKillSwitch({ global: false, repoPaused: true })).toBe("repo");
    expect(resolveMinerKillSwitch({ global: false, repoPaused: false })).toBe("none");

    const tripped = buildMinerKillSwitchTransitionGovernorLedgerEvent({
      actionClass: "test",
      previousScope: "none",
      scope: "repo",
    });
    expect(tripped).toMatchObject({
      eventType: "kill_switch",
      decision: "tripped",
      payload: { previousScope: "none", scope: "repo" },
    });

    const resumed = buildMinerKillSwitchTransitionGovernorLedgerEvent({
      actionClass: "test",
      previousScope: "repo",
      scope: "none",
    });
    expect(resumed).toMatchObject({
      eventType: "kill_switch",
      decision: "resumed",
      payload: { previousScope: "repo", scope: "none" },
    });

    expect(
      buildMinerKillSwitchTransitionGovernorLedgerEvent({
        actionClass: "test",
        previousScope: "repo",
        scope: "repo",
      }),
    ).toBeNull();
  });

  it("warns operators off the cooperative governor pause CLI during kill-switch incidents", () => {
    const runbook = readFileSync(runbookPath, "utf8");
    expect(runbook).toMatch(/governor pause/);
    expect(runbook).toMatch(/do not reach for those commands/i);
  });
});
