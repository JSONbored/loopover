import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AUTONOMY_LEVELS as CONTRACT_AUTONOMY_LEVELS } from "@loopover/contract";
import { AUTONOMY_LEVELS } from "../../src/settings/autonomy";

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
import {
  closeFixtureServer,
  repoOnboardingPackFixture,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #6153: the CLI carried its own hand-synced copy of the autonomy levels, because it reaches
// @loopover/engine through a published export map that does not surface AUTONOMY_LEVELS -- and it drifted,
// accepting "suggest"/"propose" for the whole life of #4620 after the server dropped them. #9762 deleted the
// copy: the bin imports the list from @loopover/contract, which both packages can reach.
//
// So the guard below stopped being a text comparison and became a behavioural one. It runs `set-level` for
// every level the live enum declares and asserts each is accepted, then asserts an invented level is not --
// which is the property that actually matters, and one no import-shaped assertion could establish.

// #8587: these cases assert JSON / plain business output that the exported runCli produces in-process (the
// isProcessEntrypoint guard lets the committed .ts source be imported without hijacking argv), so they no longer
// spawn dist/bin/loopover-mcp.js per call. One fixture server + config dir serves the whole file because the bin
// reads LOOPOVER_API_URL / LOOPOVER_CONFIG_DIR at module load; startFixtureServer reads `fixtureOptions` per
// request, so per-test response overrides (repoDocRefresh) and the capture arrays need no server restart.
type BinModule = { runCli: (args: string[]) => Promise<void> };

let tempDir = "";
let mod: BinModule;
const issueDraftBodies: Array<{
  dryRun?: boolean;
  create?: boolean;
  limit?: number;
}> = [];
const planIssuesBodies: Array<{
  goal?: string;
  dryRun?: boolean;
  create?: boolean;
  limit?: number;
}> = [];
const apiRequests: Array<{ url: string; method: string }> = [];
const fixtureOptions: Parameters<typeof startFixtureServer>[0] = {
  onIssueDraftRequest: (body) => void issueDraftBodies.push(body),
  onPlanIssuesRequest: (body) => void planIssuesBodies.push(body),
  onApiRequest: (request) =>
    void apiRequests.push({
      url: request.url ?? "",
      method: request.method ?? "",
    }),
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
  const url = await startFixtureServer(fixtureOptions);
  // The bin reads LOOPOVER_API_URL and LOOPOVER_CONFIG_DIR at module load, so set the env BEFORE importing
  // (hence the dynamic import). LOOPOVER_TOKEN is read at call time.
  process.env.LOOPOVER_API_URL = url;
  process.env.LOOPOVER_TOKEN = "session-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_TOKEN;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

beforeEach(() => {
  issueDraftBodies.length = 0;
  planIssuesBodies.length = 0;
  apiRequests.length = 0;
  fixtureOptions.repoDocRefresh = undefined;
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

/** In-process stand-in for the subprocess harness: dispatch through the exported runCli, return stdout. */
function cli(args: string[]): Promise<string> {
  return captureStdout(() => mod.runCli(args));
}

describe("loopover-mcp CLI — maintain (#784)", () => {
  it("status lists the agent approval queue (plain + json)", async () => {
    const out = await cli(["maintain", "status", "--repo", "owner/repo"]);
    expect(out).toMatch(/Agent approval queue for owner\/repo: 1 pending/);
    expect(out).toMatch(/pa-1\s+merge on #7\s+clean/);
    const json = JSON.parse(
      await cli(["maintain", "status", "--repo", "owner/repo", "--json"]),
    ) as { pendingActions: Array<{ id: string; actionClass: string }> };
    expect(json.pendingActions[0]).toMatchObject({
      id: "pa-1",
      actionClass: "merge",
    });
  });

  it("queue lists pending action ids that maintain approve can consume (#2236)", async () => {
    const plain = await cli(["maintain", "queue", "--repo", "owner/repo"]);
    expect(plain).toMatch(/Pending agent actions for owner\/repo: 1\./);
    expect(plain).toMatch(/pa-1\s+merge\s+#7\s+clean/);
    const payload = JSON.parse(
      await cli(["maintain", "pending", "--repo", "owner/repo", "--json"]),
    ) as {
      pendingActions: Array<{
        id: string;
        actionClass: string;
        pullNumber: number;
      }>;
    };
    expect(payload.pendingActions).toHaveLength(1);
    expect(payload.pendingActions[0]).toMatchObject({
      id: "pa-1",
      actionClass: "merge",
      pullNumber: 7,
    });
    expect(plain).toContain(payload.pendingActions[0]!.id);
    expect(
      await cli([
        "maintain",
        "approve",
        payload.pendingActions[0]!.id,
        "--repo",
        "owner/repo",
      ]),
    ).toMatch(/Accepted pa-1: accepted \(completed\)/);
  });

  it("approve executes a staged action; reject cancels one", async () => {
    expect(
      await cli(["maintain", "approve", "pa-1", "--repo", "owner/repo"]),
    ).toMatch(/Accepted pa-1: accepted \(completed\)/);
    expect(
      await cli(["maintain", "reject", "pa-1", "--repo", "owner/repo"]),
    ).toMatch(/Rejected pa-1: rejected/);
  });

  it("pause and resume toggle the repo kill-switch", async () => {
    expect(await cli(["maintain", "pause", "--repo", "owner/repo"])).toMatch(
      /Agent actions paused for owner\/repo/,
    );
    expect(await cli(["maintain", "resume", "--repo", "owner/repo"])).toMatch(
      /Agent actions resumed for owner\/repo/,
    );
  });

  it("set-level merges one action class into the autonomy dial (read-merge-write)", async () => {
    const json = JSON.parse(
      await cli([
        "maintain",
        "set-level",
        "merge",
        "auto_with_approval",
        "--repo",
        "owner/repo",
        "--json",
      ]),
    ) as { autonomy: Record<string, string> };
    // existing label:auto preserved + merge added
    expect(json.autonomy).toMatchObject({
      label: "auto",
      merge: "auto_with_approval",
    });
    const plain = await cli([
      "maintain",
      "set-level",
      "merge",
      "auto",
      "--repo",
      "owner/repo",
    ]);
    expect(plain).toMatch(/Set merge autonomy to auto for owner\/repo/);
  });

  it("precision reports gate false-positive telemetry (plain + json), passing the window through", async () => {
    const out = await cli(["maintain", "precision", "--repo", "owner/repo"]);
    expect(out).toMatch(
      /Gate precision for owner\/repo \(all history\): 11 blocked, 2 blocked-then-merged, false-positive rate 18%/,
    );
    expect(out).toMatch(/duplicate-pr: 8 blocked, 2 merged anyway \(25% FP\)/);
    // A per-type rate of null (below sample) is rendered without an FP suffix.
    expect(out).toMatch(/missing-linked-issue: 3 blocked, 0 merged anyway$/m);
    expect(out).toMatch(/Highest false-positive gate: `duplicate-pr`/);
    const json = JSON.parse(
      await cli(["maintain", "precision", "--repo", "owner/repo", "--json"]),
    ) as {
      overall: { blocked: number; falsePositiveRate: number };
    };
    expect(json.overall).toMatchObject({
      blocked: 11,
      falsePositiveRate: 0.182,
    });
    // --window-days bounds the ledger; the CLI forwards it as ?windowDays and reflects it in the summary.
    const scoped = await cli([
      "maintain",
      "precision",
      "--repo",
      "owner/repo",
      "--window-days",
      "30",
    ]);
    expect(scoped).toMatch(/Gate precision for owner\/repo \(last 30d\)/);
  });

  it("generate-issue-drafts dry-runs by default and never forwards create (#6757)", async () => {
    const out = await cli([
      "maintain",
      "generate-issue-drafts",
      "--repo",
      "owner/repo",
    ]);
    // A bare invocation must send {create:false, dryRun:true} — the tool can never silently create.
    expect(issueDraftBodies[0]).toMatchObject({ create: false, dryRun: true });
    expect(out).toMatch(
      /Contributor issue drafts for owner\/repo \(dry-run\): 1 proposed, 0 created/,
    );
    // The generated draft title carries an ANSI escape; the plain-text path must strip it (#6261).
    expect(out).toContain("Add cursor pagination");
    expect(out).not.toContain("[31m");
  });

  it("generate-issue-drafts --create forwards {create:true, dryRun:false} and reports created issues (#6757)", async () => {
    const out = await cli([
      "maintain",
      "generate-issue-drafts",
      "--repo",
      "owner/repo",
      "--create",
      "--limit",
      "3",
    ]);
    // --create maps to the exact {create:true, dryRun:false} shape the route's create-safety guard demands,
    // and --limit is forwarded as a number.
    expect(issueDraftBodies[0]).toMatchObject({
      create: true,
      dryRun: false,
      limit: 3,
    });
    expect(out).toMatch(/\(create\): 1 proposed, 1 created/);
    expect(out).toMatch(/#42 https:\/\/github\.com\/owner\/repo\/issues\/42/);
    const json = JSON.parse(
      await cli([
        "maintain",
        "generate-issue-drafts",
        "--repo",
        "owner/repo",
        "--json",
      ]),
    ) as {
      dryRun: boolean;
      createRequested: boolean;
    };
    expect(json).toMatchObject({ dryRun: true, createRequested: false });
  });

  it("plan-issues requires --goal and dry-runs by default, never forwarding create (#7764)", async () => {
    // Missing --goal fails before any request is made.
    await expect(
      cli(["maintain", "plan-issues", "--repo", "owner/repo"]),
    ).rejects.toThrow(/planning goal/);
    const out = await cli([
      "maintain",
      "plan-issues",
      "--repo",
      "owner/repo",
      "--goal",
      "Improve docs",
    ]);
    // A bare invocation must send {create:false, dryRun:true} — the CLI can never silently create.
    expect(planIssuesBodies[0]).toMatchObject({
      goal: "Improve docs",
      create: false,
      dryRun: true,
    });
    expect(out).toMatch(
      /Issue plan for owner\/repo \(dry-run, status=ok\): 1 proposed, 0 created/,
    );
    // The AI-generated draft title carries an ANSI escape; the plain-text path must strip it (#6261).
    expect(out).toContain("Add cursor pagination");
    expect(out).not.toContain("[31m");
  });

  it("plan-issues --create forwards {create:true, dryRun:false} and reports created issues (#7764)", async () => {
    const out = await cli([
      "maintain",
      "plan-issues",
      "--repo",
      "owner/repo",
      "--goal",
      "Ship it",
      "--create",
      "--limit",
      "3",
    ]);
    // --create maps to the exact {create:true, dryRun:false} shape the route's create-safety guard demands,
    // and --limit is forwarded as a number.
    expect(planIssuesBodies[0]).toMatchObject({
      goal: "Ship it",
      create: true,
      dryRun: false,
      limit: 3,
    });
    expect(out).toMatch(/\(create, status=ok\): 0 proposed, 1 created/);
    expect(out).toMatch(/#51 https:\/\/github\.com\/owner\/repo\/issues\/51/);
    const json = JSON.parse(
      await cli([
        "maintain",
        "plan-issues",
        "--repo",
        "owner/repo",
        "--goal",
        "x",
        "--json",
      ]),
    ) as {
      dryRun: boolean;
      createRequested: boolean;
    };
    expect(json).toMatchObject({ dryRun: true, createRequested: false });
  });

  it("outcome-calibration reports slop-band merge rates + recommendation outcomes (plain + json), passing the window through (#6735)", async () => {
    const out = await cli([
      "maintain",
      "outcome-calibration",
      "--repo",
      "owner/repo",
    ]);
    expect(out).toMatch(
      /Outcome calibration for owner\/repo \(all history\): recommendations 14 positive, 3 negative, 3 pending \(positive rate 82%\)/,
    );
    expect(out).toMatch(
      /clean: 75% merge rate over 12 PR\(s\) \(9 merged, 3 closed\)/,
    );
    expect(out).toMatch(/high: 25% merge rate over 4 PR\(s\)/);
    expect(out).toMatch(/Higher-slop bands merge less often/);
    const json = JSON.parse(
      await cli([
        "maintain",
        "outcome-calibration",
        "--repo",
        "owner/repo",
        "--json",
      ]),
    ) as {
      recommendations: { positive: number; positiveRate: number };
      slop: Array<{ band: string }>;
    };
    expect(json.recommendations).toMatchObject({
      positive: 14,
      positiveRate: 0.82,
    });
    expect(json.slop.map((band) => band.band)).toEqual(["clean", "high"]);
    // --window-days bounds the recommendation window; the CLI forwards it as ?windowDays and reflects it.
    const scoped = await cli([
      "maintain",
      "outcome-calibration",
      "--repo",
      "owner/repo",
      "--window-days",
      "30",
    ]);
    expect(scoped).toMatch(/Outcome calibration for owner\/repo \(last 30d\)/);
  });

  it("onboarding-pack mirrors the session-gated API payload and forwards refresh", async () => {
    const json = JSON.parse(
      await cli([
        "maintain",
        "onboarding-pack",
        "--repo",
        "owner/repo",
        "--refresh",
        "--json",
      ]),
    );
    expect(json).toEqual(repoOnboardingPackFixture);
    expect(apiRequests.at(-1)?.url).toBe(
      "/v1/repos/owner/repo/onboarding-pack/preview?refresh=true",
    );

    const plain = await cli([
      "maintain",
      "onboarding-pack",
      "--repo",
      "owner/repo",
    ]);
    expect(plain).toContain(
      "LoopOver onboarding pack preview for owner/repo (preview-only, not published).",
    );
    expect(plain).toContain(repoOnboardingPackFixture.preview.previewMarkdown);
    expect(apiRequests.at(-1)?.url).toBe(
      "/v1/repos/owner/repo/onboarding-pack/preview",
    );
  });

  it("audit-feed shows the agent audit feed (plain + json), with output parity between the surfaces (#6733)", async () => {
    const out = await cli(["maintain", "audit-feed", "--repo", "owner/repo"]);
    expect(out).toMatch(/Agent audit feed for owner\/repo: 2 events\./);
    expect(out).toMatch(
      /2026-05-30T00:00:00\.000Z {2}github_app\.merged {2}loopover {2}success {2}merged #7/,
    );
    // A null detail is dropped from the line rather than printed as the string "null".
    expect(out).toMatch(
      /github_app\.review_evasion_closed {2}loopover {2}denied$/m,
    );
    // Parity: --json re-serializes the API payload untouched, so the same events reach both surfaces.
    const json = JSON.parse(
      await cli(["maintain", "audit-feed", "--repo", "owner/repo", "--json"]),
    ) as {
      repoFullName: string;
      events: Array<{ id: string }>;
    };
    expect(json.repoFullName).toBe("owner/repo");
    expect(json.events.map((event) => event.id)).toEqual(["ae-1", "ae-2"]);
  });

  it("audit-feed forwards --since/--limit/--pull to the route and scopes the header to the pull (#6733)", async () => {
    // The API validates these (ISO since, limit 1..200, positive pull), so the CLI must forward them verbatim
    // rather than re-deciding locally -- this pins that they actually arrive.
    const payload = JSON.parse(
      await cli([
        "maintain",
        "audit-feed",
        "--repo",
        "owner/repo",
        "--since",
        "2026-05-29T00:00:00.000Z",
        "--limit",
        "1",
        "--pull",
        "7",
        "--json",
      ]),
    ) as {
      echoedQuery: { since: string; limit: string; pull: string };
      events: unknown[];
    };
    expect(payload.echoedQuery).toEqual({
      since: "2026-05-29T00:00:00.000Z",
      limit: "1",
      pull: "7",
    });
    expect(payload.events).toHaveLength(1);
    // The ?pull= branch echoes pullNumber, and the plain-text header reflects that scope.
    const scoped = await cli([
      "maintain",
      "audit-feed",
      "--repo",
      "owner/repo",
      "--pull",
      "7",
    ]);
    expect(scoped).toMatch(/Agent audit feed for owner\/repo#7: /);
  });

  it("audit-feed omits absent flags from the query entirely, so the route applies its own defaults (#6733)", async () => {
    const payload = JSON.parse(
      await cli(["maintain", "audit-feed", "--repo", "owner/repo", "--json"]),
    ) as {
      echoedQuery: {
        since: string | null;
        limit: string | null;
        pull: string | null;
      };
    };
    expect(payload.echoedQuery).toEqual({
      since: null,
      limit: null,
      pull: null,
    });
  });

  it("automation-state shows the derived agent automation view (plain + json), with output parity (#6742)", async () => {
    const out = await cli([
      "maintain",
      "automation-state",
      "--repo",
      "owner/repo",
    ]);
    expect(out).toMatch(
      /Agent automation for owner\/repo: mode=live, 2 acting class\(es\), 3 pending approval\(s\)\./,
    );
    expect(out).toMatch(/permission readiness: ready/);
    expect(out).toMatch(/acting classes: merge, close/);
    // Parity: --json re-serializes the API payload untouched, so the derived fields reach both surfaces.
    const json = JSON.parse(
      await cli([
        "maintain",
        "automation-state",
        "--repo",
        "owner/repo",
        "--json",
      ]),
    ) as {
      repoFullName: string;
      mode: string;
      permissionReadiness: string;
      pendingActionCount: number;
    };
    expect(json).toMatchObject({
      repoFullName: "owner/repo",
      mode: "live",
      permissionReadiness: "ready",
      pendingActionCount: 3,
    });
  });

  it("refresh-docs reports a newly opened repo-doc PR (plain + json), with output parity between the surfaces (#6743)", async () => {
    fixtureOptions.repoDocRefresh = {
      opened: true,
      reused: false,
      pullNumber: 42,
      url: "https://github.com/owner/repo/pull/42",
      claudeMode: "symlink",
    };
    const out = await cli(["maintain", "refresh-docs", "--repo", "owner/repo"]);
    expect(out).toBe(
      "Opened a new repo-doc pull request for owner/repo: https://github.com/owner/repo/pull/42\n",
    );
    const json = JSON.parse(
      await cli(["maintain", "refresh-docs", "--repo", "owner/repo", "--json"]),
    ) as {
      opened: boolean;
      pullNumber: number;
    };
    expect(json).toMatchObject({ opened: true, pullNumber: 42 });
  });

  it("refresh-docs reports the already-open PR when the route reuses one (#6743)", async () => {
    fixtureOptions.repoDocRefresh = {
      opened: true,
      reused: true,
      pullNumber: 42,
      url: "https://github.com/owner/repo/pull/42",
      claudeMode: "copy",
    };
    const out = await cli(["maintain", "refresh-docs", "--repo", "owner/repo"]);
    expect(out).toBe(
      "Found the already-open repo-doc pull request for owner/repo: https://github.com/owner/repo/pull/42\n",
    );
  });

  it("refresh-docs reports why no PR was opened, sanitizing the reason (#6743)", async () => {
    fixtureOptions.repoDocRefresh = {
      opened: false,
      reason: "no changes needed",
    };
    const out = await cli(["maintain", "refresh-docs", "--repo", "owner/repo"]);
    expect(out).toBe(
      "No repo-doc pull request opened for owner/repo: no changes needed\n",
    );
  });

  it("propose stages a new action (plain + json), POSTing to the bare pending-actions path", async () => {
    const plain = await cli([
      "maintain",
      "propose",
      "review",
      "7",
      "--repo",
      "owner/repo",
      "--reason",
      "needs a look",
    ]);
    expect(plain).toMatch(
      /Staged review on owner\/repo#7 \(pending\), id pa-1\./,
    );
    // The bare create path (no trailing slash) — distinct from the decision `/:id/:decision` POST.
    expect(apiRequests.at(-1)).toEqual({
      url: "/v1/repos/owner/repo/agent/pending-actions",
      method: "POST",
    });
    const json = JSON.parse(
      await cli([
        "maintain",
        "propose",
        "merge",
        "7",
        "--repo",
        "owner/repo",
        "--merge-method",
        "squash",
        "--json",
      ]),
    ) as {
      created: boolean;
      action: { actionClass: string; pullNumber: number };
    };
    expect(json).toMatchObject({
      created: true,
      action: { actionClass: "merge", pullNumber: 7 },
    });
  });

  it("propose validates the action class and pull number before any request", async () => {
    await expect(
      cli(["maintain", "propose", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Usage: loopover-mcp maintain propose/);
    await expect(
      cli(["maintain", "propose", "review", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Usage: loopover-mcp maintain propose/);
    await expect(
      cli(["maintain", "propose", "bogus", "7", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Unknown action class/);
    await expect(
      cli(["maintain", "propose", "review", "0", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Invalid pull number/);
    await expect(
      cli(["maintain", "propose", "review", "1.5", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Invalid pull number/);
  }, 45_000);

  it("validates inputs: --repo required, id required for approve, known subcommand + action/level", async () => {
    await expect(cli(["maintain", "status"])).rejects.toThrow(/Pass --repo/);
    await expect(
      cli(["maintain", "approve", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Pass the pending-action id/);
    await expect(
      cli(["maintain", "bogus", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Unknown maintain subcommand/);
    await expect(
      cli(["maintain", "set-level", "merge", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Usage: loopover-mcp maintain set-level/);
    await expect(
      cli(["maintain", "set-level", "bogus", "auto", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Unknown action/);
    await expect(
      cli(["maintain", "set-level", "merge", "bogus", "--repo", "owner/repo"]),
    ).rejects.toThrow(/Unknown level/);
  }, 45_000);

  // Pins the INVARIANT -- the CLI accepts exactly what the live enum declares -- by EXERCISING it, not by
  // reading the source. #9762 removed the hand-synced literal this used to scrape, and a grep for the
  // replacement import would assert how the code is written rather than what it does: it would pass just as
  // happily on a CLI that imported the list and then ignored it.
  it("accepts every level the live autonomy enum declares (#6153, #9762)", async () => {
    for (const level of AUTONOMY_LEVELS) {
      await expect(cli(["maintain", "set-level", "review", level, "--repo", "owner/repo", "--json"])).resolves.toBeDefined();
    }
  }, 45_000);

  it("accepts NOTHING outside it, and says so naming the live enum (#6153, #9762)", async () => {
    // The #6153 defect: the CLI carried "suggest"/"propose" for the whole life of #4620, after the server had
    // dropped them. The rejection message is derived from the same enum, so a level added server-side cannot
    // leave the error text stale either.
    await expect(cli(["maintain", "set-level", "review", "definitely-not-a-level", "--repo", "owner/repo"])).rejects.toThrow(
      new RegExp(AUTONOMY_LEVELS.join(", ")),
    );
    expect([...CONTRACT_AUTONOMY_LEVELS], "the value the CLI imports is still the engine's").toEqual([...AUTONOMY_LEVELS]);
  });

  // #6153 regression: the CLI accepted "suggest"/"propose" for the whole life of #4620, which dropped them
  // server-side. The fixture's PUT /settings echoes any autonomy body back as a success, exactly like a server
  // with no enum -- so a rejection here can only have come from the CLI's own check, before any round-trip.
  it("rejects levels #4620 removed server-side, client-side rather than via a 400 (#6153)", async () => {
    for (const removed of ["suggest", "propose"]) {
      // Derived from the live enum for the same reason as above: the point is that the error names exactly the
      // levels the server accepts, not that it names three particular strings.
      await expect(
        cli([
          "maintain",
          "set-level",
          "review",
          removed,
          "--repo",
          "owner/repo",
        ]),
      ).rejects.toThrow(
        new RegExp(
          `Unknown level: ${removed}\\. Use ${AUTONOMY_LEVELS.join(", ")}\\.`,
        ),
      );
    }
    // The dial still accepts every level the server does -- the fix narrowed the list, it didn't break it.
    const json = JSON.parse(
      await cli([
        "maintain",
        "set-level",
        "review",
        "observe",
        "--repo",
        "owner/repo",
        "--json",
      ]),
    ) as {
      autonomy: Record<string, string>;
    };
    expect(json.autonomy).toMatchObject({ review: "observe" });
  }, 45_000);

  it("prints help when invoked with no subcommand", async () => {
    const out = await cli(["maintain"]);
    expect(out).toMatch(/Usage: loopover-mcp maintain/);
    expect(out).toMatch(/approve <id>/);
    expect(out).toMatch(/propose <class> <pull-num>/);
    expect(out).toMatch(/queue/);
    expect(out).toMatch(/pause/);
    expect(out).toMatch(/onboarding-pack/);
  });
});
