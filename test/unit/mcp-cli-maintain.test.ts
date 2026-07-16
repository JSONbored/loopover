import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTONOMY_LEVELS } from "../../src/settings/autonomy";
import { closeFixtureServer, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

// #6153: MAINTAIN_AUTONOMY_LEVELS is a hand-synced copy of the live enum (the CLI reaches @loopover/engine only
// through its published export map, which doesn't surface AUTONOMY_LEVELS), so nothing but a test can catch the
// two drifting apart. The source is parsed rather than imported because bin/loopover-mcp.js is an executable
// entrypoint that starts a server on import.
const CLI_SOURCE = readFileSync(join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js"), "utf8");

/** The `maintain set-level` levels the committed CLI source really accepts. */
function declaredLevels(): string[] {
  const raw = /const MAINTAIN_AUTONOMY_LEVELS = \[([^\]]*)\];/.exec(CLI_SOURCE)?.[1] ?? "";
  return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("loopover-mcp CLI — maintain (#784)", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function env() {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer();
    return { LOOPOVER_API_URL: url, LOOPOVER_TOKEN: "session-token", LOOPOVER_CONFIG_DIR: tempDir, LOOPOVER_API_TIMEOUT_MS: "1000" };
  }

  it("status lists the agent approval queue (plain + json)", async () => {
    const e = await env();
    const out = await runAsync(["maintain", "status", "--repo", "owner/repo"], e);
    expect(out).toMatch(/Agent approval queue for owner\/repo: 1 pending/);
    expect(out).toMatch(/pa-1\s+merge on #7\s+clean/);
    const json = JSON.parse(await runAsync(["maintain", "status", "--repo", "owner/repo", "--json"], e)) as { pendingActions: Array<{ id: string; actionClass: string }> };
    expect(json.pendingActions[0]).toMatchObject({ id: "pa-1", actionClass: "merge" });
  });

  it("queue lists pending action ids that maintain approve can consume (#2236)", async () => {
    const e = await env();
    const plain = await runAsync(["maintain", "queue", "--repo", "owner/repo"], e);
    expect(plain).toMatch(/Pending agent actions for owner\/repo: 1\./);
    expect(plain).toMatch(/pa-1\s+merge\s+#7\s+clean/);
    const payload = JSON.parse(await runAsync(["maintain", "pending", "--repo", "owner/repo", "--json"], e)) as {
      pendingActions: Array<{ id: string; actionClass: string; pullNumber: number }>;
    };
    expect(payload.pendingActions).toHaveLength(1);
    expect(payload.pendingActions[0]).toMatchObject({ id: "pa-1", actionClass: "merge", pullNumber: 7 });
    expect(plain).toContain(payload.pendingActions[0]!.id);
    expect(await runAsync(["maintain", "approve", payload.pendingActions[0]!.id, "--repo", "owner/repo"], e)).toMatch(
      /Accepted pa-1: accepted \(completed\)/,
    );
  });

  it("approve executes a staged action; reject cancels one", async () => {
    const e = await env();
    expect(await runAsync(["maintain", "approve", "pa-1", "--repo", "owner/repo"], e)).toMatch(/Accepted pa-1: accepted \(completed\)/);
    expect(await runAsync(["maintain", "reject", "pa-1", "--repo", "owner/repo"], e)).toMatch(/Rejected pa-1: rejected/);
  });

  it("pause and resume toggle the repo kill-switch", async () => {
    const e = await env();
    expect(await runAsync(["maintain", "pause", "--repo", "owner/repo"], e)).toMatch(/Agent actions paused for owner\/repo/);
    expect(await runAsync(["maintain", "resume", "--repo", "owner/repo"], e)).toMatch(/Agent actions resumed for owner\/repo/);
  });

  it("set-level merges one action class into the autonomy dial (read-merge-write)", async () => {
    const e = await env();
    const json = JSON.parse(await runAsync(["maintain", "set-level", "merge", "auto_with_approval", "--repo", "owner/repo", "--json"], e)) as { autonomy: Record<string, string> };
    // existing label:auto preserved + merge added
    expect(json.autonomy).toMatchObject({ label: "auto", merge: "auto_with_approval" });
    const plain = await runAsync(["maintain", "set-level", "merge", "auto", "--repo", "owner/repo"], e);
    expect(plain).toMatch(/Set merge autonomy to auto for owner\/repo/);
  });

  it("precision reports gate false-positive telemetry (plain + json), passing the window through", async () => {
    const e = await env();
    const out = await runAsync(["maintain", "precision", "--repo", "owner/repo"], e);
    expect(out).toMatch(/Gate precision for owner\/repo \(all history\): 11 blocked, 2 blocked-then-merged, false-positive rate 18%/);
    expect(out).toMatch(/duplicate-pr: 8 blocked, 2 merged anyway \(25% FP\)/);
    // A per-type rate of null (below sample) is rendered without an FP suffix.
    expect(out).toMatch(/missing-linked-issue: 3 blocked, 0 merged anyway$/m);
    expect(out).toMatch(/Highest false-positive gate: `duplicate-pr`/);
    const json = JSON.parse(await runAsync(["maintain", "precision", "--repo", "owner/repo", "--json"], e)) as {
      overall: { blocked: number; falsePositiveRate: number };
    };
    expect(json.overall).toMatchObject({ blocked: 11, falsePositiveRate: 0.182 });
    // --window-days bounds the ledger; the CLI forwards it as ?windowDays and reflects it in the summary.
    const scoped = await runAsync(["maintain", "precision", "--repo", "owner/repo", "--window-days", "30"], e);
    expect(scoped).toMatch(/Gate precision for owner\/repo \(last 30d\)/);
  });

  it("validates inputs: --repo required, id required for approve, known subcommand + action/level", async () => {
    const e = await env();
    await expect(runAsync(["maintain", "status"], e)).rejects.toThrow(/Pass --repo/);
    await expect(runAsync(["maintain", "approve", "--repo", "owner/repo"], e)).rejects.toThrow(/Pass the pending-action id/);
    await expect(runAsync(["maintain", "bogus", "--repo", "owner/repo"], e)).rejects.toThrow(/Unknown maintain subcommand/);
    await expect(runAsync(["maintain", "set-level", "merge", "--repo", "owner/repo"], e)).rejects.toThrow(/Usage: loopover-mcp maintain set-level/);
    await expect(runAsync(["maintain", "set-level", "bogus", "auto", "--repo", "owner/repo"], e)).rejects.toThrow(/Unknown action/);
    await expect(runAsync(["maintain", "set-level", "merge", "bogus", "--repo", "owner/repo"], e)).rejects.toThrow(/Unknown level/);
  }, 45_000);

  // Pins the INVARIANT (the two lists agree), not today's three values -- restating the literal here would just
  // create a third hand-synced copy that rots alongside the one this guards.
  it("set-level's levels stay in sync with the live autonomy enum (#6153)", () => {
    expect(declaredLevels()).toEqual([...AUTONOMY_LEVELS]);
  });

  // #6153 regression: the CLI accepted "suggest"/"propose" for the whole life of #4620, which dropped them
  // server-side. The fixture's PUT /settings echoes any autonomy body back as a success, exactly like a server
  // with no enum -- so a rejection here can only have come from the CLI's own check, before any round-trip.
  it("rejects levels #4620 removed server-side, client-side rather than via a 400 (#6153)", async () => {
    const e = await env();
    for (const removed of ["suggest", "propose"]) {
      // Derived from the live enum for the same reason as above: the point is that the error names exactly the
      // levels the server accepts, not that it names three particular strings.
      await expect(runAsync(["maintain", "set-level", "review", removed, "--repo", "owner/repo"], e)).rejects.toThrow(
        new RegExp(`Unknown level: ${removed}\\. Use ${AUTONOMY_LEVELS.join(", ")}\\.`),
      );
    }
    // The dial still accepts every level the server does -- the fix narrowed the list, it didn't break it.
    const json = JSON.parse(await runAsync(["maintain", "set-level", "review", "observe", "--repo", "owner/repo", "--json"], e)) as {
      autonomy: Record<string, string>;
    };
    expect(json.autonomy).toMatchObject({ review: "observe" });
  }, 45_000);

  it("prints help when invoked with no subcommand", async () => {
    const e = await env();
    const out = await runAsync(["maintain"], e);
    expect(out).toMatch(/Usage: loopover-mcp maintain/);
    expect(out).toMatch(/approve <id>/);
    expect(out).toMatch(/queue/);
    expect(out).toMatch(/pause/);
  });
});
