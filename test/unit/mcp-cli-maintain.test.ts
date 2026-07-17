import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTONOMY_LEVELS } from "../../src/settings/autonomy";
import { closeFixtureServer, repoOnboardingPackFixture, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

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

  async function env(options: Parameters<typeof startFixtureServer>[0] = {}) {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    const url = await startFixtureServer(options);
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

  it("generate-issue-drafts dry-runs by default and never forwards create (#6757)", async () => {
    const bodies: Array<{ dryRun?: boolean; create?: boolean; limit?: number }> = [];
    const e = await env({ onIssueDraftRequest: (b) => bodies.push(b) });
    const out = await runAsync(["maintain", "generate-issue-drafts", "--repo", "owner/repo"], e);
    // A bare invocation must send {create:false, dryRun:true} — the tool can never silently create.
    expect(bodies[0]).toMatchObject({ create: false, dryRun: true });
    expect(out).toMatch(/Contributor issue drafts for owner\/repo \(dry-run\): 1 proposed, 0 created/);
    // The generated draft title carries an ANSI escape; the plain-text path must strip it (#6261).
    expect(out).toContain("Add cursor pagination");
    expect(out).not.toContain("[31m");
  });

  it("generate-issue-drafts --create forwards {create:true, dryRun:false} and reports created issues (#6757)", async () => {
    const bodies: Array<{ dryRun?: boolean; create?: boolean; limit?: number }> = [];
    const e = await env({ onIssueDraftRequest: (b) => bodies.push(b) });
    const out = await runAsync(["maintain", "generate-issue-drafts", "--repo", "owner/repo", "--create", "--limit", "3"], e);
    // --create maps to the exact {create:true, dryRun:false} shape the route's create-safety guard demands,
    // and --limit is forwarded as a number.
    expect(bodies[0]).toMatchObject({ create: true, dryRun: false, limit: 3 });
    expect(out).toMatch(/\(create\): 1 proposed, 1 created/);
    expect(out).toMatch(/#42 https:\/\/github\.com\/owner\/repo\/issues\/42/);
    const json = JSON.parse(await runAsync(["maintain", "generate-issue-drafts", "--repo", "owner/repo", "--json"], e)) as {
      dryRun: boolean;
      createRequested: boolean;
    };
    expect(json).toMatchObject({ dryRun: true, createRequested: false });
  });

  it("outcome-calibration reports slop-band merge rates + recommendation outcomes (plain + json), passing the window through (#6735)", async () => {
    const e = await env();
    const out = await runAsync(["maintain", "outcome-calibration", "--repo", "owner/repo"], e);
    expect(out).toMatch(/Outcome calibration for owner\/repo \(all history\): recommendations 14 positive, 3 negative, 3 pending \(positive rate 82%\)/);
    expect(out).toMatch(/clean: 75% merge rate over 12 PR\(s\) \(9 merged, 3 closed\)/);
    expect(out).toMatch(/high: 25% merge rate over 4 PR\(s\)/);
    expect(out).toMatch(/Higher-slop bands merge less often/);
    const json = JSON.parse(await runAsync(["maintain", "outcome-calibration", "--repo", "owner/repo", "--json"], e)) as {
      recommendations: { positive: number; positiveRate: number };
      slop: Array<{ band: string }>;
    };
    expect(json.recommendations).toMatchObject({ positive: 14, positiveRate: 0.82 });
    expect(json.slop.map((band) => band.band)).toEqual(["clean", "high"]);
    // --window-days bounds the recommendation window; the CLI forwards it as ?windowDays and reflects it.
    const scoped = await runAsync(["maintain", "outcome-calibration", "--repo", "owner/repo", "--window-days", "30"], e);
    expect(scoped).toMatch(/Outcome calibration for owner\/repo \(last 30d\)/);
  });

  it("onboarding-pack mirrors the session-gated API payload and forwards refresh", async () => {
    const requests: string[] = [];
    const e = await env({ onApiRequest: (request) => requests.push(request.url ?? "") });

    const json = JSON.parse(
      await runAsync(["maintain", "onboarding-pack", "--repo", "owner/repo", "--refresh", "--json"], e),
    );
    expect(json).toEqual(repoOnboardingPackFixture);
    expect(requests.at(-1)).toBe("/v1/repos/owner/repo/onboarding-pack/preview?refresh=true");

    const plain = await runAsync(["maintain", "onboarding-pack", "--repo", "owner/repo"], e);
    expect(plain).toContain("LoopOver onboarding pack preview for owner/repo (preview-only, not published).");
    expect(plain).toContain(repoOnboardingPackFixture.preview.previewMarkdown);
    expect(requests.at(-1)).toBe("/v1/repos/owner/repo/onboarding-pack/preview");
  });

  it("audit-feed shows the agent audit feed (plain + json), with output parity between the surfaces (#6733)", async () => {
    const e = await env();
    const out = await runAsync(["maintain", "audit-feed", "--repo", "owner/repo"], e);
    expect(out).toMatch(/Agent audit feed for owner\/repo: 2 events\./);
    expect(out).toMatch(/2026-05-30T00:00:00\.000Z {2}github_app\.merged {2}loopover {2}success {2}merged #7/);
    // A null detail is dropped from the line rather than printed as the string "null".
    expect(out).toMatch(/github_app\.review_evasion_closed {2}loopover {2}denied$/m);
    // Parity: --json re-serializes the API payload untouched, so the same events reach both surfaces.
    const json = JSON.parse(await runAsync(["maintain", "audit-feed", "--repo", "owner/repo", "--json"], e)) as {
      repoFullName: string;
      events: Array<{ id: string }>;
    };
    expect(json.repoFullName).toBe("owner/repo");
    expect(json.events.map((event) => event.id)).toEqual(["ae-1", "ae-2"]);
  });

  it("audit-feed forwards --since/--limit/--pull to the route and scopes the header to the pull (#6733)", async () => {
    const e = await env();
    // The API validates these (ISO since, limit 1..200, positive pull), so the CLI must forward them verbatim
    // rather than re-deciding locally -- this pins that they actually arrive.
    const payload = JSON.parse(
      await runAsync(
        ["maintain", "audit-feed", "--repo", "owner/repo", "--since", "2026-05-29T00:00:00.000Z", "--limit", "1", "--pull", "7", "--json"],
        e,
      ),
    ) as { echoedQuery: { since: string; limit: string; pull: string }; events: unknown[] };
    expect(payload.echoedQuery).toEqual({ since: "2026-05-29T00:00:00.000Z", limit: "1", pull: "7" });
    expect(payload.events).toHaveLength(1);
    // The ?pull= branch echoes pullNumber, and the plain-text header reflects that scope.
    const scoped = await runAsync(["maintain", "audit-feed", "--repo", "owner/repo", "--pull", "7"], e);
    expect(scoped).toMatch(/Agent audit feed for owner\/repo#7: /);
  });

  it("audit-feed omits absent flags from the query entirely, so the route applies its own defaults (#6733)", async () => {
    const e = await env();
    const payload = JSON.parse(await runAsync(["maintain", "audit-feed", "--repo", "owner/repo", "--json"], e)) as {
      echoedQuery: { since: string | null; limit: string | null; pull: string | null };
    };
    expect(payload.echoedQuery).toEqual({ since: null, limit: null, pull: null });
  });

  it("automation-state shows the derived agent automation view (plain + json), with output parity (#6742)", async () => {
    const e = await env();
    const out = await runAsync(["maintain", "automation-state", "--repo", "owner/repo"], e);
    expect(out).toMatch(/Agent automation for owner\/repo: mode=live, 2 acting class\(es\), 3 pending approval\(s\)\./);
    expect(out).toMatch(/permission readiness: ready/);
    expect(out).toMatch(/acting classes: merge, close/);
    // Parity: --json re-serializes the API payload untouched, so the derived fields reach both surfaces.
    const json = JSON.parse(await runAsync(["maintain", "automation-state", "--repo", "owner/repo", "--json"], e)) as {
      repoFullName: string;
      mode: string;
      permissionReadiness: string;
      pendingActionCount: number;
    };
    expect(json).toMatchObject({ repoFullName: "owner/repo", mode: "live", permissionReadiness: "ready", pendingActionCount: 3 });
  });

  it("refresh-docs reports a newly opened repo-doc PR (plain + json), with output parity between the surfaces (#6743)", async () => {
    const e = await env({
      repoDocRefresh: { opened: true, reused: false, pullNumber: 42, url: "https://github.com/owner/repo/pull/42", claudeMode: "symlink" },
    });
    const out = await runAsync(["maintain", "refresh-docs", "--repo", "owner/repo"], e);
    expect(out).toBe("Opened a new repo-doc pull request for owner/repo: https://github.com/owner/repo/pull/42\n");
    const json = JSON.parse(await runAsync(["maintain", "refresh-docs", "--repo", "owner/repo", "--json"], e)) as {
      opened: boolean;
      pullNumber: number;
    };
    expect(json).toMatchObject({ opened: true, pullNumber: 42 });
  });

  it("refresh-docs reports the already-open PR when the route reuses one (#6743)", async () => {
    const e = await env({
      repoDocRefresh: { opened: true, reused: true, pullNumber: 42, url: "https://github.com/owner/repo/pull/42", claudeMode: "copy" },
    });
    const out = await runAsync(["maintain", "refresh-docs", "--repo", "owner/repo"], e);
    expect(out).toBe("Found the already-open repo-doc pull request for owner/repo: https://github.com/owner/repo/pull/42\n");
  });

  it("refresh-docs reports why no PR was opened, sanitizing the reason (#6743)", async () => {
    const e = await env({ repoDocRefresh: { opened: false, reason: "no changes needed" } });
    const out = await runAsync(["maintain", "refresh-docs", "--repo", "owner/repo"], e);
    expect(out).toBe("No repo-doc pull request opened for owner/repo: no changes needed\n");
  });

  it("propose stages a new action (plain + json), POSTing to the bare pending-actions path", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const e = await env({ onApiRequest: (request) => void requests.push({ url: request.url ?? "", method: request.method ?? "" }) });
    const plain = await runAsync(["maintain", "propose", "review", "7", "--repo", "owner/repo", "--reason", "needs a look"], e);
    expect(plain).toMatch(/Staged review on owner\/repo#7 \(pending\), id pa-1\./);
    // The bare create path (no trailing slash) — distinct from the decision `/:id/:decision` POST.
    expect(requests.at(-1)).toEqual({ url: "/v1/repos/owner/repo/agent/pending-actions", method: "POST" });
    const json = JSON.parse(await runAsync(["maintain", "propose", "merge", "7", "--repo", "owner/repo", "--merge-method", "squash", "--json"], e)) as {
      created: boolean;
      action: { actionClass: string; pullNumber: number };
    };
    expect(json).toMatchObject({ created: true, action: { actionClass: "merge", pullNumber: 7 } });
  });

  it("propose validates the action class and pull number before any request", async () => {
    const e = await env();
    await expect(runAsync(["maintain", "propose", "--repo", "owner/repo"], e)).rejects.toThrow(/Usage: loopover-mcp maintain propose/);
    await expect(runAsync(["maintain", "propose", "review", "--repo", "owner/repo"], e)).rejects.toThrow(/Usage: loopover-mcp maintain propose/);
    await expect(runAsync(["maintain", "propose", "bogus", "7", "--repo", "owner/repo"], e)).rejects.toThrow(/Unknown action class/);
    await expect(runAsync(["maintain", "propose", "review", "0", "--repo", "owner/repo"], e)).rejects.toThrow(/Invalid pull number/);
    await expect(runAsync(["maintain", "propose", "review", "1.5", "--repo", "owner/repo"], e)).rejects.toThrow(/Invalid pull number/);
  }, 45_000);

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
    expect(out).toMatch(/propose <class> <pull-num>/);
    expect(out).toMatch(/queue/);
    expect(out).toMatch(/pause/);
    expect(out).toMatch(/onboarding-pack/);
  });
});
