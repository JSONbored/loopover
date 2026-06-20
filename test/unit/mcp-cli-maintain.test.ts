import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — maintain (#784)", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  async function env() {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    const url = await startFixtureServer();
    return { GITTENSORY_API_URL: url, GITTENSORY_TOKEN: "session-token", GITTENSORY_CONFIG_DIR: tempDir, GITTENSORY_API_TIMEOUT_MS: "1000" };
  }

  it("status lists the agent approval queue (plain + json)", async () => {
    const e = await env();
    const out = await runAsync(["maintain", "status", "--repo", "owner/repo"], e);
    expect(out).toMatch(/Agent approval queue for owner\/repo: 1 pending/);
    expect(out).toMatch(/pa-1\s+merge on #7\s+clean/);
    const json = JSON.parse(await runAsync(["maintain", "status", "--repo", "owner/repo", "--json"], e)) as { pendingActions: Array<{ id: string; actionClass: string }> };
    expect(json.pendingActions[0]).toMatchObject({ id: "pa-1", actionClass: "merge" });
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

  it("validates inputs: --repo required, id required for approve, known subcommand + action/level", async () => {
    const e = await env();
    await expect(runAsync(["maintain", "status"], e)).rejects.toThrow(/Pass --repo/);
    await expect(runAsync(["maintain", "approve", "--repo", "owner/repo"], e)).rejects.toThrow(/Pass the pending-action id/);
    await expect(runAsync(["maintain", "bogus", "--repo", "owner/repo"], e)).rejects.toThrow(/Unknown maintain subcommand/);
    await expect(runAsync(["maintain", "set-level", "merge", "--repo", "owner/repo"], e)).rejects.toThrow(/Usage: gittensory-mcp maintain set-level/);
    await expect(runAsync(["maintain", "set-level", "bogus", "auto", "--repo", "owner/repo"], e)).rejects.toThrow(/Unknown action/);
    await expect(runAsync(["maintain", "set-level", "merge", "bogus", "--repo", "owner/repo"], e)).rejects.toThrow(/Unknown level/);
  });

  it("prints help when invoked with no subcommand", async () => {
    const e = await env();
    const out = await runAsync(["maintain"], e);
    expect(out).toMatch(/Usage: gittensory-mcp maintain/);
    expect(out).toMatch(/approve <id>/);
    expect(out).toMatch(/pause/);
  });
});
