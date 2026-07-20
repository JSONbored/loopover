import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initPolicyDocCacheStore } from "../../packages/loopover-miner/lib/policy-doc-cache.js";
import { initPolicyVerdictCacheStore } from "../../packages/loopover-miner/lib/policy-verdict-cache.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/loopover-miner/lib/portfolio-queue.js";
import { initRankedCandidatesStore } from "../../packages/loopover-miner/lib/ranked-candidates.js";
import {
  parseDiscoverArgs,
  renderDiscoverSummary,
  runDiscover,
  sanitizeDiscoverDisplayText,
} from "../../packages/loopover-miner/lib/discover-cli.js";
import { bin, runCapture } from "./support/miner-cli-harness";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempQueueStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-cli-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  stores.push(store);
  return store;
}

// An injected policy-doc cache keeps runDiscover from opening the real on-disk cache in ~/.config for every test
// that only cares about the fan-out/rank/enqueue path (#4842). runDiscover doesn't own an injected store, so the
// afterEach hook below closes it.
function tempPolicyDocCacheStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-cli-pdc-"));
  roots.push(root);
  const store = initPolicyDocCacheStore(join(root, "policy-doc-cache.sqlite3"));
  stores.push(store);
  return store;
}

// Same reasoning as tempPolicyDocCacheStore above, for the policy-verdict cache (#4843).
function tempPolicyVerdictCacheStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-cli-pvc-"));
  roots.push(root);
  const store = initPolicyVerdictCacheStore(
    join(root, "policy-verdict-cache.sqlite3"),
  );
  stores.push(store);
  return store;
}

// Same reasoning as tempPolicyDocCacheStore above, for the ranked-candidates snapshot store (#4859 prerequisite).
function tempRankedCandidatesStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-cli-rc-"));
  roots.push(root);
  const store = initRankedCandidatesStore(
    join(root, "ranked-candidates.sqlite3"),
  );
  stores.push(store);
  return store;
}

function fanOutIssue(overrides: Record<string, unknown> = {}) {
  return {
    owner: "acme",
    repo: "widgets",
    repoFullName: "acme/widgets",
    issueNumber: 1,
    title: "Add queue retry helper",
    labels: ["help wanted"],
    assignees: [],
    commentsCount: 1,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    htmlUrl: "https://github.com/acme/widgets/issues/1",
    aiPolicyAllowed: true as const,
    aiPolicySource: "none" as const,
    ...overrides,
  };
}

// A hosted discovery-index candidate (#7168 shape). assignees is optional in the contract (#7442) — omit it to
// simulate an older server build that never populated the field.
function indexCandidate(overrides: Record<string, unknown> = {}) {
  return {
    owner: "acme",
    repo: "widgets",
    repoFullName: "acme/widgets",
    issueNumber: 2,
    title: "index-sourced issue",
    labels: ["help wanted"],
    commentsCount: 0,
    createdAt: null,
    updatedAt: null,
    htmlUrl: null,
    aiPolicyAllowed: true as const,
    aiPolicySource: "none" as const,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("parseDiscoverArgs (#4247)", () => {
  it("requires either repo targets or --search", () => {
    expect(parseDiscoverArgs([])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner discover"),
    });
  });

  it("parses one or more owner/repo targets plus --json", () => {
    expect(
      parseDiscoverArgs(["acme/widgets", "acme/gadgets", "--json"]),
    ).toEqual({
      targets: [
        { owner: "acme", repo: "widgets" },
        { owner: "acme", repo: "gadgets" },
      ],
      search: null,
      dryRun: false,
      json: true,
    });
  });

  it("parses --search as an alternative to repo targets", () => {
    expect(parseDiscoverArgs(["--search", "label:bug"])).toEqual({
      targets: [],
      search: "label:bug",
      dryRun: false,
      json: false,
    });
  });

  it("rejects malformed repo targets", () => {
    expect(parseDiscoverArgs(["not-a-repo"])).toEqual({
      error: "Repository must be in owner/repo form: not-a-repo",
    });
  });

  it("REGRESSION: rejects a three-segment repo target", () => {
    expect(parseDiscoverArgs(["acme/widgets/extra"])).toEqual({
      error: "Repository must be in owner/repo form: acme/widgets/extra",
    });
  });

  it("rejects mixing repo targets with --search", () => {
    expect(parseDiscoverArgs(["acme/widgets", "--search", "x"])).toEqual({
      error: "Pass either repository targets or --search, not both.",
    });
  });

  it("rejects a --search flag missing its query and unknown options", () => {
    expect(parseDiscoverArgs(["--search"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner discover"),
    });
    expect(parseDiscoverArgs(["--search", "--json"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner discover"),
    });
    expect(parseDiscoverArgs(["acme/widgets", "--verbose"])).toEqual({
      error: "Unknown option: --verbose",
    });
  });

  it("parses the per-tenant --api-base-url and --token-env flags (#4784)", () => {
    expect(
      parseDiscoverArgs([
        "acme/widgets",
        "--api-base-url",
        "https://ghe.example.com/api/v3",
        "--token-env",
        "FORGE_PAT",
      ]),
    ).toEqual({
      targets: [{ owner: "acme", repo: "widgets" }],
      search: null,
      dryRun: false,
      json: false,
      apiBaseUrl: "https://ghe.example.com/api/v3",
      tokenEnv: "FORGE_PAT",
    });
  });

  it("omits --api-base-url / --token-env keys entirely when not supplied (#4784)", () => {
    expect(parseDiscoverArgs(["acme/widgets"])).toEqual({
      targets: [{ owner: "acme", repo: "widgets" }],
      search: null,
      dryRun: false,
      json: false,
    });
  });

  it("parses --dry-run (#4847)", () => {
    expect(parseDiscoverArgs(["acme/widgets", "--dry-run", "--json"])).toEqual({
      targets: [{ owner: "acme", repo: "widgets" }],
      search: null,
      dryRun: true,
      json: true,
    });
  });

  it("rejects --api-base-url / --token-env missing their value (#4784)", () => {
    expect(parseDiscoverArgs(["acme/widgets", "--api-base-url"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner discover"),
    });
    expect(
      parseDiscoverArgs(["acme/widgets", "--api-base-url", "--json"]),
    ).toEqual({
      error: expect.stringContaining("Usage: loopover-miner discover"),
    });
    expect(parseDiscoverArgs(["acme/widgets", "--token-env"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner discover"),
    });
    expect(
      parseDiscoverArgs(["acme/widgets", "--token-env", "--json"]),
    ).toEqual({
      error: expect.stringContaining("Usage: loopover-miner discover"),
    });
  });
});

describe("renderDiscoverSummary (#4247)", () => {
  it("summarizes fan-out, ranking, and enqueue counts with top candidates", () => {
    const text = renderDiscoverSummary({
      fanOutCount: 2,
      warnings: [
        {
          repoFullName: "acme/banned",
          stage: "policy:AI-USAGE.md",
          message: "denied",
        },
      ],
      rateLimitRemaining: 4993,
      rateLimitResetAt: "2026-07-09T13:00:00.000Z",
      ranked: [
        {
          repoFullName: "acme/widgets",
          issueNumber: 1,
          title: "Add retry helper",
          rankScore: 0.8,
        },
        {
          repoFullName: "acme/widgets",
          issueNumber: 2,
          title: "Fix flaky test",
          rankScore: 0.4,
        },
      ],
      enqueueSummary: {
        enqueued: 2,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });
    expect(text).toContain("fanned out: 2 candidate issue(s)");
    expect(text).toContain("ai-policy warnings: 1");
    expect(text).toContain("ranked: 2");
    expect(text).toContain("enqueued: 2");
    expect(text).toContain(
      "rate-limit remaining: 4993 (resets 2026-07-09T13:00:00.000Z)",
    );
    expect(text).toContain("acme/widgets#1  score=0.8000  Add retry helper");
    expect(text).not.toContain("skipped (below min rank)");
  });

  it("strips terminal control sequences from candidate titles", () => {
    const text = renderDiscoverSummary({
      fanOutCount: 1,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [
        {
          repoFullName: "acme/widgets",
          issueNumber: 1,
          title:
            "normal\nSPOOFED: enqueued: 999\u001b[31m red \u001b]8;;https://attacker.example\u0007CLICK\u001b]8;;\u0007 cod\u202eexe",
          rankScore: 0.8,
        },
      ],
      enqueueSummary: {
        enqueued: 1,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });

    expect(text).toContain("normal SPOOFED: enqueued: 999 red CLICK codexe");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u202e");
    expect(
      text.split("\n").filter((line) => line.includes("SPOOFED")),
    ).toHaveLength(1);
  });

  it("bounds sanitized title display text and handles nullish values", () => {
    expect(sanitizeDiscoverDisplayText(null)).toBe("");
    expect(sanitizeDiscoverDisplayText(`safe ${"x".repeat(300)}`)).toHaveLength(
      240,
    );
  });

  it("reports skipped-below-min-rank counts and an empty-result message", () => {
    const withSkips = renderDiscoverSummary({
      fanOutCount: 1,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [
        {
          repoFullName: "acme/widgets",
          issueNumber: 1,
          title: "x",
          rankScore: 0.1,
        },
      ],
      enqueueSummary: {
        enqueued: 0,
        skippedBelowMinRank: 1,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });
    expect(withSkips).toContain("skipped (below min rank): 1");

    const empty = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [],
      enqueueSummary: {
        enqueued: 0,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });
    expect(empty).toContain("no candidates found.");
    // Without the flag the fall-back note is absent (the default-goal-spec branch is opt-in on the result).
    expect(empty).not.toContain("built-in default goal spec");
  });

  it("surfaces the default-goal-spec fall-back note when no per-tenant spec was supplied (#4784)", () => {
    const text = renderDiscoverSummary({
      fanOutCount: 1,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [
        {
          repoFullName: "acme/widgets",
          issueNumber: 1,
          title: "x",
          rankScore: 0.8,
        },
      ],
      usedDefaultGoalSpec: true,
      enqueueSummary: {
        enqueued: 1,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });
    expect(text).toContain("ranked with the built-in default goal spec");
  });

  it("surfaces rate-limit telemetry, and reports 'unknown' when the fanout captured none (#4837)", () => {
    const withTelemetry = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: 12,
      rateLimitResetAt: "2026-07-09T13:30:00.000Z",
      ranked: [],
      enqueueSummary: {
        enqueued: 0,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });
    expect(withTelemetry).toContain(
      "rate-limit remaining: 12 (resets 2026-07-09T13:30:00.000Z)",
    );

    // A remaining count of zero must still print the number, not fall through to "unknown".
    const throttled = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: 0,
      rateLimitResetAt: null,
      ranked: [],
      enqueueSummary: {
        enqueued: 0,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });
    expect(throttled).toContain("rate-limit remaining: 0");
    expect(throttled).not.toContain("resets");

    const noTelemetry = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [],
      enqueueSummary: {
        enqueued: 0,
        skippedBelowMinRank: 0,
        skippedInvalid: 0,
        eventsAppended: 0,
      },
    });
    expect(noTelemetry).toContain("rate-limit remaining: unknown");
  });
});

describe("runDiscover (#4247)", () => {
  it("fans out repo targets, ranks, and enqueues into the real portfolio queue", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [
        fanOutIssue({
          issueNumber: 1,
          title: "Add retry helper",
          labels: ["help wanted", "feature"],
        }),
        fanOutIssue({
          issueNumber: 2,
          title: "Fix flaky test",
          labels: ["help wanted"],
        }),
      ],
      warnings: [],
      rateLimitRemaining: 4987,
      rateLimitResetAt: "2026-07-09T13:00:00.000Z",
    }));
    const searchCandidateIssuesWithSummary = vi.fn(async () => {
      throw new Error("must not be called for repo-target mode");
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      searchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    expect(fetchCandidateIssuesWithSummary).toHaveBeenCalledWith(
      [{ owner: "acme", repo: "widgets" }],
      "",
      expect.objectContaining({}),
    );
    expect(searchCandidateIssuesWithSummary).not.toHaveBeenCalled();

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.fanOutCount).toBe(2);
    expect(payload.enqueueSummary.enqueued).toBe(2);
    expect(
      payload.ranked.map((entry: { issueNumber: number }) => entry.issueNumber),
    ).toEqual([1, 2]);
    // The fanout's rate-limit telemetry is surfaced verbatim in --json output (#4837).
    expect(payload.rateLimitRemaining).toBe(4987);
    expect(payload.rateLimitResetAt).toBe("2026-07-09T13:00:00.000Z");

    const queued = portfolioQueue.listQueue("acme/widgets");
    expect(queued.map((entry) => entry.identifier).sort()).toEqual([
      "issue:1",
      "issue:2",
    ]);
  });

  it("REGRESSION (#7442): a discovery-index candidate assigned to its own repo owner is excluded once real assignees flow through", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1, title: "direct fan-out issue" })],
      warnings: [],
      rateLimitRemaining: 5000,
      rateLimitResetAt: "2026-07-09T13:00:00.000Z",
    }));
    // The hosted index supplies a DIFFERENT issue (so it survives dedupe) assigned to the repo owner "acme".
    const queryDiscoveryIndex = vi.fn(async () => ({ contractVersion: 1, candidates: [indexCandidate({ issueNumber: 2, assignees: ["acme"] })], nextCursor: null }));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      env: { ...process.env, LOOPOVER_MINER_DISCOVERY_PLANE: "1" },
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      queryDiscoveryIndex: queryDiscoveryIndex as never,
    });

    expect(exitCode).toBe(0);
    expect(queryDiscoveryIndex).toHaveBeenCalled();
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    // The owner-assigned index candidate (issue 2) is excluded by the #7040 filter; only the direct fan-out issue survives.
    expect(payload.ranked.map((e: { issueNumber: number }) => e.issueNumber)).toEqual([1]);
    expect(portfolioQueue.listQueue("acme/widgets").map((e) => e.identifier)).toEqual(["issue:1"]);
  });

  it("REGRESSION (#7442): a discovery-index response that omits assignees falls back to [] and still runs the filter (kept, not skipped)", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1, title: "direct fan-out issue" })],
      warnings: [],
      rateLimitRemaining: 5000,
      rateLimitResetAt: "2026-07-09T13:00:00.000Z",
    }));
    // Older server build: the candidate carries NO assignees field at all.
    const queryDiscoveryIndex = vi.fn(async () => ({ contractVersion: 1, candidates: [indexCandidate({ issueNumber: 2 })], nextCursor: null }));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      env: { ...process.env, LOOPOVER_MINER_DISCOVERY_PLANE: "1" },
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      queryDiscoveryIndex: queryDiscoveryIndex as never,
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    // Fail-safe: the omitted field becomes [], the owner-exclusion filter still runs (finds no assignment), issue 2 is KEPT.
    expect(payload.ranked.map((e: { issueNumber: number }) => e.issueNumber).sort()).toEqual([1, 2]);
    expect(portfolioQueue.listQueue("acme/widgets").map((e) => e.identifier).sort()).toEqual(["issue:1", "issue:2"]);
  });

  it("#4847: --dry-run performs the real fan-out/rank but never opens any local store", async () => {
    const initPortfolioQueue = vi.fn();
    const initPolicyDocCache = vi.fn();
    const initPolicyVerdictCache = vi.fn();
    const initRankedCandidatesStore = vi.fn();
    const fetchCandidateIssuesWithSummary = vi.fn(
      async (targets, token, fanOutOptions) => {
        expect(fanOutOptions).toMatchObject({
          policyDocCache: null,
          policyVerdictCache: null,
        });
        return {
          issues: [fanOutIssue({ issueNumber: 1, title: "Add retry helper" })],
          warnings: [],
          rateLimitRemaining: 4990,
          rateLimitResetAt: "2026-07-09T13:00:00.000Z",
        };
      },
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(
      ["acme/widgets", "--dry-run", "--json"],
      {
        nowMs: NOW,
        initPortfolioQueue,
        initPolicyDocCache,
        initPolicyVerdictCache,
        initRankedCandidatesStore,
        fetchCandidateIssuesWithSummary,
      },
    );

    expect(exitCode).toBe(0);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(initPolicyDocCache).not.toHaveBeenCalled();
    expect(initPolicyVerdictCache).not.toHaveBeenCalled();
    expect(initRankedCandidatesStore).not.toHaveBeenCalled();
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.outcome).toBe("dry_run");
    expect(payload.fanOutCount).toBe(1);
    expect(payload.enqueueSummary.enqueued).toBe(1);
    expect(
      payload.ranked.map((entry: { issueNumber: number }) => entry.issueNumber),
    ).toEqual([1]);

    log.mockClear();
    const textExitCode = await runDiscover(["acme/widgets", "--dry-run"], {
      nowMs: NOW,
      initPortfolioQueue,
      initPolicyDocCache,
      initPolicyVerdictCache,
      initRankedCandidatesStore,
      fetchCandidateIssuesWithSummary,
    });
    expect(textExitCode).toBe(0);
    expect(String(log.mock.calls[1]?.[0])).toContain(
      "DRY RUN: no portfolio-queue write was made.",
    );
  });

  it("REGRESSION: dry-run omits nowMs when unset and forwards goalSpecsByRepo when set", async () => {
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1 })],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    const goalSpecsByRepo = { "acme/widgets": { minerEnabled: true } };
    const rankCandidateIssuesWithSummary = vi.fn((_issues: unknown[], _opts?: Record<string, unknown>) => ({
      issues: [
        {
          ...fanOutIssue({ issueNumber: 1 }),
          potential: 0.5,
          feasibility: 0.5,
          laneFit: 0.5,
          freshness: 0.5,
          dupRisk: 0,
          rankScore: 0.5,
        },
      ],
      skippedInvalid: 0,
      usedDefaultGoalSpec: false,
      defaultGoalSpec: {} as never,
    }));
    const resolveContributionProfiles = vi.fn(
      async (_repos: string[], _ctx?: Record<string, unknown>) => new Map(),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--dry-run", "--json"], {
      // deliberately omit nowMs — exercise the omit arm of the optional spreads
      fetchCandidateIssuesWithSummary,
      rankCandidateIssuesWithSummary,
      resolveContributionProfiles,
      goalSpecsByRepo: goalSpecsByRepo as never,
    });

    expect(exitCode).toBe(0);
    const resolveCtx = resolveContributionProfiles.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(resolveCtx).not.toHaveProperty("nowMs");
    expect(resolveCtx).not.toHaveProperty("apiBaseUrl");

    expect(rankCandidateIssuesWithSummary).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ goalSpecsByRepo }),
    );
    const rankOpts = rankCandidateIssuesWithSummary.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(rankOpts).not.toHaveProperty("nowMs");
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).outcome).toBe("dry_run");

    // Include arms: nowMs + apiBaseUrl present; goalSpecsByRepo omitted.
    resolveContributionProfiles.mockClear();
    rankCandidateIssuesWithSummary.mockClear();
    await runDiscover(["acme/widgets", "--dry-run", "--json"], {
      nowMs: NOW,
      apiBaseUrl: "https://ghe.example.com/api/v3",
      fetchCandidateIssuesWithSummary,
      rankCandidateIssuesWithSummary,
      resolveContributionProfiles,
    });
    expect(resolveContributionProfiles.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        nowMs: NOW,
        apiBaseUrl: "https://ghe.example.com/api/v3",
      }),
    );
    const rankOptsWithNow = rankCandidateIssuesWithSummary.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(rankOptsWithNow).toMatchObject({ nowMs: NOW });
    expect(rankOptsWithNow).not.toHaveProperty("goalSpecsByRepo");

    // Dry-run include arm for goalSpecContentByRepo.
    rankCandidateIssuesWithSummary.mockClear();
    await runDiscover(["acme/widgets", "--dry-run", "--json"], {
      nowMs: NOW,
      fetchCandidateIssuesWithSummary,
      rankCandidateIssuesWithSummary,
      resolveContributionProfiles,
      goalSpecContentByRepo: { "acme/widgets": "minerEnabled: true\n" },
    });
    expect(rankCandidateIssuesWithSummary).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ goalSpecContentByRepo: { "acme/widgets": "minerEnabled: true\n" } }),
    );
  });

  it("REGRESSION: non-dry-run omits nowMs when unset and includes goalSpecsByRepo when set", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1 })],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    const goalSpecsByRepo = { "acme/widgets": { minerEnabled: true } };
    const rankCandidateIssuesWithSummary = vi.fn((_issues: unknown[], _opts?: Record<string, unknown>) => ({
      issues: [
        {
          ...fanOutIssue({ issueNumber: 1 }),
          potential: 0.5,
          feasibility: 0.5,
          laneFit: 0.5,
          freshness: 0.5,
          dupRisk: 0,
          rankScore: 0.5,
        },
      ],
      skippedInvalid: 0,
      usedDefaultGoalSpec: false,
      defaultGoalSpec: {} as never,
    }));
    const resolveContributionProfiles = vi.fn(
      async (_repos: string[], _ctx?: Record<string, unknown>) => new Map(),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      // omit nowMs
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      rankCandidateIssuesWithSummary,
      resolveContributionProfiles,
      goalSpecsByRepo: goalSpecsByRepo as never,
    });

    expect(exitCode).toBe(0);
    const resolveCtx = resolveContributionProfiles.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(resolveCtx).not.toHaveProperty("nowMs");
    expect(rankCandidateIssuesWithSummary).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ goalSpecsByRepo }),
    );
    const rankOpts = rankCandidateIssuesWithSummary.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(rankOpts).not.toHaveProperty("nowMs");
  });

  it("#4847: --dry-run reports fan-out failures and exits non-zero without opening any local store", async () => {
    const initPortfolioQueue = vi.fn();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => {
      throw new Error("github_unreachable");
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--dry-run"], {
      nowMs: NOW,
      initPortfolioQueue,
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(2);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("github_unreachable");
  });

  it("#5830: --dry-run --json reports fan-out failures as a parseable {ok:false,error} object", async () => {
    const initPortfolioQueue = vi.fn();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => {
      throw new Error("github_unreachable");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(
      ["acme/widgets", "--dry-run", "--json"],
      {
        nowMs: NOW,
        initPortfolioQueue,
        fetchCandidateIssuesWithSummary,
      },
    );

    expect(exitCode).toBe(2);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toEqual({ ok: false, error: "github_unreachable" });
  });

  it("#4847: --dry-run stringifies a thrown non-Error value instead of crashing", async () => {
    const fetchCandidateIssuesWithSummary = vi.fn(async () => {
      throw "raw_string_fault";
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--dry-run"], {
      nowMs: NOW,
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith("raw_string_fault");
  });

  it("#4847: --dry-run works in --search mode too, never calling the repo fan-out", async () => {
    const initPortfolioQueue = vi.fn();
    const searchCandidateIssuesWithSummary = vi.fn(async (query: string) => ({
      issues: [fanOutIssue({ issueNumber: 9, title: `Result for ${query}` })],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    const fetchCandidateIssuesWithSummary = vi.fn(async () => {
      throw new Error("must not be called in --search mode");
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(
      ["--search", "label:bug", "--dry-run", "--json"],
      {
        nowMs: NOW,
        initPortfolioQueue,
        searchCandidateIssuesWithSummary,
        fetchCandidateIssuesWithSummary,
      },
    );

    expect(exitCode).toBe(0);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(fetchCandidateIssuesWithSummary).not.toHaveBeenCalled();
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.outcome).toBe("dry_run");
    expect(payload.ranked[0]?.title).toContain("Result for label:bug");
  });

  it("uses --search instead of repo targets and never calls the repo fan-out", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => {
      throw new Error("must not be called in --search mode");
    });
    const searchCandidateIssuesWithSummary = vi.fn(async (query: string) => ({
      issues: [fanOutIssue({ issueNumber: 9, title: `Result for ${query}` })],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["--search", "label:bug"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      searchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    expect(searchCandidateIssuesWithSummary).toHaveBeenCalledWith(
      "label:bug",
      "",
      expect.objectContaining({}),
    );
    expect(fetchCandidateIssuesWithSummary).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("Result for label:bug");
  });

  it("prints a human-readable summary by default (no --json)", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue()],
      warnings: [],
      rateLimitRemaining: 3200,
      rateLimitResetAt: "2026-07-09T13:00:00.000Z",
    }));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("fanned out: 1 candidate issue(s)");
    expect(text).toContain(
      "rate-limit remaining: 3200 (resets 2026-07-09T13:00:00.000Z)",
    );
    expect(text).toContain("top candidates:");
  });

  it("prints argument errors without opening the portfolio queue", async () => {
    const initPortfolioQueue = vi.fn(() => {
      throw new Error("must not open the queue on a parse error");
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runDiscover(["not-a-repo"], { initPortfolioQueue });
    expect(exitCode).toBe(2);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Repository must be in owner/repo form: not-a-repo",
    );
  });

  it("emits JSON when portfolio queue open fails with --json (#4836)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      initPortfolioQueue: () => {
        throw new Error("portfolio_db_locked");
      },
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "portfolio_db_locked",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("reports fan-out failures and exits non-zero without leaking the error", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => {
      throw new Error("github_unreachable");
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets"], {
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith("github_unreachable");
  });

  it("opens and closes the default on-disk portfolio queue when no override is supplied", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "loopover-miner-discover-cli-default-"),
    );
    roots.push(root);
    const dbPath = join(root, "portfolio-queue.sqlite3");
    const previousDbPath = process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB;
    process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB = dbPath;
    try {
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues: [fanOutIssue({ issueNumber: 5 })],
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const exitCode = await runDiscover(["acme/widgets"], {
        nowMs: NOW,
        fetchCandidateIssuesWithSummary,
        initPolicyDocCache: () => tempPolicyDocCacheStore(),
        initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
        initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      });
      expect(exitCode).toBe(0);

      // runDiscover owned and closed this store itself (no initPortfolioQueue override was passed); reopening
      // the same file confirms the enqueue was actually persisted through the default code path.
      const reopened = initPortfolioQueueStore(dbPath);
      stores.push(reopened);
      expect(reopened.listQueue().map((entry) => entry.identifier)).toEqual([
        "issue:5",
      ]);
    } finally {
      if (previousDbPath === undefined)
        delete process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB;
      else process.env.LOOPOVER_MINER_PORTFOLIO_QUEUE_DB = previousDbPath;
    }
  });

  it("threads --token-env and --api-base-url into the fan-out (#4784)", async () => {
    const portfolioQueue = tempQueueStore();
    const previous = process.env.FORGE_PAT;
    process.env.FORGE_PAT = "tenant-secret";
    try {
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues: [fanOutIssue()],
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const exitCode = await runDiscover(
        [
          "acme/widgets",
          "--api-base-url",
          "https://ghe.example.com/api/v3",
          "--token-env",
          "FORGE_PAT",
        ],
        {
          nowMs: NOW,
          initPortfolioQueue: () => portfolioQueue,
          initPolicyDocCache: () => tempPolicyDocCacheStore(),
          initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
          initRankedCandidatesStore: () => tempRankedCandidatesStore(),
          fetchCandidateIssuesWithSummary,
        },
      );

      expect(exitCode).toBe(0);
      expect(fetchCandidateIssuesWithSummary).toHaveBeenCalledWith(
        [{ owner: "acme", repo: "widgets" }],
        "tenant-secret",
        expect.objectContaining({
          apiBaseUrl: "https://ghe.example.com/api/v3",
        }),
      );
      // REGRESSION (#5563): the enqueued portfolio-queue row itself carries the resolved forge host, not just
      // the fan-out call — otherwise a same-named repo on github.com would collide with this GHE tenant's row.
      expect(portfolioQueue.listQueue()).toEqual([
        expect.objectContaining({
          apiBaseUrl: "https://ghe.example.com/api/v3",
        }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.FORGE_PAT;
      else process.env.FORGE_PAT = previous;
    }
  });

  it("defaults the credential env var to the forge adapter's tokenEnvVar when no --token-env is given (#4784)", async () => {
    const portfolioQueue = tempQueueStore();
    const previous = process.env.FORGE_PAT;
    process.env.FORGE_PAT = "tenant-secret";
    try {
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues: [fanOutIssue()],
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const exitCode = await runDiscover(["acme/widgets"], {
        nowMs: NOW,
        initPortfolioQueue: () => portfolioQueue,
        initPolicyDocCache: () => tempPolicyDocCacheStore(),
        initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
        initRankedCandidatesStore: () => tempRankedCandidatesStore(),
        fetchCandidateIssuesWithSummary,
        forge: { tokenEnvVar: "FORGE_PAT" },
      });

      expect(exitCode).toBe(0);
      expect(fetchCandidateIssuesWithSummary).toHaveBeenCalledWith(
        [{ owner: "acme", repo: "widgets" }],
        "tenant-secret",
        expect.any(Object),
      );
    } finally {
      if (previous === undefined) delete process.env.FORGE_PAT;
      else process.env.FORGE_PAT = previous;
    }
  });

  it("prefers an explicit githubToken option and a programmatic apiBaseUrl / tokenEnv (#4784)", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue()],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      githubToken: "explicit-token",
      apiBaseUrl: "https://programmatic.example.com",
      tokenEnv: "IGNORED_BECAUSE_TOKEN_IS_EXPLICIT",
      // A token is set, so the default profile resolver would otherwise reach the network — no-op it (#6798).
      resolveContributionProfiles: async () => new Map(),
    });

    expect(exitCode).toBe(0);
    expect(fetchCandidateIssuesWithSummary).toHaveBeenCalledWith(
      [{ owner: "acme", repo: "widgets" }],
      "explicit-token",
      expect.objectContaining({
        apiBaseUrl: "https://programmatic.example.com",
      }),
    );
  });

  it("forwards a per-tenant goal spec to the ranker and surfaces usedDefaultGoalSpec (#4784)", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue()],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    const goalSpecContentByRepo = { "acme/widgets": "minerEnabled: true\n" };
    const rankCandidateIssuesWithSummary = vi.fn(() => ({
      issues: [
        {
          ...fanOutIssue(),
          potential: 0.5,
          feasibility: 0.5,
          laneFit: 0.5,
          freshness: 0.5,
          dupRisk: 0,
          rankScore: 0.5,
        },
      ],
      skippedInvalid: 0,
      usedDefaultGoalSpec: false,
      defaultGoalSpec: {} as never,
    }));

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      rankCandidateIssuesWithSummary,
      goalSpecContentByRepo,
    });

    expect(exitCode).toBe(0);
    expect(rankCandidateIssuesWithSummary).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ goalSpecContentByRepo }),
    );
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.usedDefaultGoalSpec).toBe(false);
  });

  it("opens and closes the default on-disk policy-doc cache when no override is supplied", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "loopover-miner-discover-cli-pdc-default-"),
    );
    roots.push(root);
    const cacheDbPath = join(root, "policy-doc-cache.sqlite3");
    const previousCacheDbPath = process.env.LOOPOVER_MINER_POLICY_DOC_CACHE_DB;
    process.env.LOOPOVER_MINER_POLICY_DOC_CACHE_DB = cacheDbPath;
    try {
      const portfolioQueue = tempQueueStore();
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues: [fanOutIssue()],
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      // No initPolicyDocCache override: runDiscover opens the default on-disk cache at the env path and closes it
      // in its finally block. Reopening the same file confirms the default code path created a usable store.
      const exitCode = await runDiscover(["acme/widgets"], {
        nowMs: NOW,
        fetchCandidateIssuesWithSummary,
        initPortfolioQueue: () => portfolioQueue,
        initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
        initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      });
      expect(exitCode).toBe(0);
      expect(existsSync(cacheDbPath)).toBe(true);

      const reopened = initPolicyDocCacheStore(cacheDbPath);
      stores.push(reopened);
      expect(
        reopened.get(
          "https://api.github.com/repos/acme/widgets/contents/AI-USAGE.md",
        ),
      ).toBeNull();
    } finally {
      if (previousCacheDbPath === undefined)
        delete process.env.LOOPOVER_MINER_POLICY_DOC_CACHE_DB;
      else process.env.LOOPOVER_MINER_POLICY_DOC_CACHE_DB = previousCacheDbPath;
    }
  });

  it("REGRESSION: a corrupt/unopenable policy-doc cache degrades to no cache instead of failing discovery", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue()],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const initPolicyDocCache = vi.fn(() => {
      throw new Error("disk full");
    });

    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache,
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
    });

    // The cache is a pure optimization: an open failure must never abort discovery (unlike the portfolio queue,
    // which IS required infrastructure) -- this is the exact bug a real contributor PR was blocked over.
    expect(exitCode).toBe(0);
    expect(initPolicyDocCache).toHaveBeenCalledTimes(1);
    expect(fetchCandidateIssuesWithSummary).toHaveBeenCalledWith(
      [{ owner: "acme", repo: "widgets" }],
      "",
      expect.objectContaining({ policyDocCache: null }),
    );
  });

  it("opens and closes the default on-disk policy-verdict cache when no override is supplied", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "loopover-miner-discover-cli-pvc-default-"),
    );
    roots.push(root);
    const cacheDbPath = join(root, "policy-verdict-cache.sqlite3");
    const previousCacheDbPath =
      process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB;
    process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB = cacheDbPath;
    try {
      const portfolioQueue = tempQueueStore();
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues: [fanOutIssue()],
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      // No initPolicyVerdictCache override: runDiscover opens the default on-disk cache at the env path and closes
      // it in its finally block. Reopening the same file confirms the default code path created a usable store.
      const exitCode = await runDiscover(["acme/widgets"], {
        nowMs: NOW,
        fetchCandidateIssuesWithSummary,
        initPortfolioQueue: () => portfolioQueue,
        initPolicyDocCache: () => tempPolicyDocCacheStore(),
        initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      });
      expect(exitCode).toBe(0);
      expect(existsSync(cacheDbPath)).toBe(true);

      const reopened = initPolicyVerdictCacheStore(cacheDbPath);
      stores.push(reopened);
      expect(reopened.get("acme/widgets")).toBeNull();
    } finally {
      if (previousCacheDbPath === undefined)
        delete process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB;
      else
        process.env.LOOPOVER_MINER_POLICY_VERDICT_CACHE_DB =
          previousCacheDbPath;
    }
  });

  it("REGRESSION: a corrupt/unopenable policy-verdict cache degrades to no cache instead of failing discovery", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue()],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const initPolicyVerdictCache = vi.fn(() => {
      throw new Error("disk full");
    });

    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache,
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
    });

    // Same discipline as the policy-doc cache above: a pure performance optimization, so an open failure must
    // never abort discovery.
    expect(exitCode).toBe(0);
    expect(initPolicyVerdictCache).toHaveBeenCalledTimes(1);
    expect(fetchCandidateIssuesWithSummary).toHaveBeenCalledWith(
      [{ owner: "acme", repo: "widgets" }],
      "",
      expect.objectContaining({ policyVerdictCache: null }),
    );
  });

  it("#4859 prerequisite: persists the full ranked-candidates snapshot after a real (non-dry-run) discover", async () => {
    const portfolioQueue = tempQueueStore();
    const rankedCandidatesStore = tempRankedCandidatesStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [
        fanOutIssue({ issueNumber: 1, title: "Add retry helper" }),
        fanOutIssue({ issueNumber: 2, title: "Fix flaky test" }),
      ],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => rankedCandidatesStore,
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    const snapshot = rankedCandidatesStore.listRankedCandidates();
    expect(snapshot.map((entry) => entry.issueNumber).sort()).toEqual([1, 2]);
    expect(
      snapshot.every((entry) => entry.rankedAt === new Date(NOW).toISOString()),
    ).toBe(true);
    // Every field opportunity-badge.js's badge needs must survive the round trip, not just rankScore.
    expect(snapshot[0]).toMatchObject({
      repoFullName: "acme/widgets",
      title: expect.any(String),
      rankScore: expect.any(Number),
      laneFit: expect.any(Number),
      freshness: expect.any(Number),
      potential: expect.any(Number),
      feasibility: expect.any(Number),
      dupRisk: expect.any(Number),
    });
  });

  it("opens and closes the default on-disk ranked-candidates store when no override is supplied", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "loopover-miner-discover-cli-rc-default-"),
    );
    roots.push(root);
    const rankedCandidatesDbPath = join(root, "ranked-candidates.sqlite3");
    const previousDbPath = process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB;
    process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB = rankedCandidatesDbPath;
    try {
      const portfolioQueue = tempQueueStore();
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues: [fanOutIssue()],
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      // No initRankedCandidatesStore override: runDiscover opens the default on-disk store at the env path and
      // closes it in its finally block. Reopening the same file confirms the default code path wrote the snapshot.
      const exitCode = await runDiscover(["acme/widgets"], {
        nowMs: NOW,
        fetchCandidateIssuesWithSummary,
        initPortfolioQueue: () => portfolioQueue,
        initPolicyDocCache: () => tempPolicyDocCacheStore(),
        initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      });
      expect(exitCode).toBe(0);
      expect(existsSync(rankedCandidatesDbPath)).toBe(true);

      const reopened = initRankedCandidatesStore(rankedCandidatesDbPath);
      stores.push(reopened);
      expect(reopened.listRankedCandidates()).toHaveLength(1);
    } finally {
      if (previousDbPath === undefined)
        delete process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB;
      else process.env.LOOPOVER_MINER_RANKED_CANDIDATES_DB = previousDbPath;
    }
  });

  it("REGRESSION: an unopenable ranked-candidates store degrades to no snapshot instead of failing discovery", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue()],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const initRankedCandidatesStore = vi.fn(() => {
      throw new Error("disk full");
    });

    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore,
      fetchCandidateIssuesWithSummary,
    });

    // Same discipline as the two caches above: a nice-to-have, not a requirement, so an open failure must never
    // abort discovery's actual job (fan out, rank, enqueue).
    expect(exitCode).toBe(0);
    expect(initRankedCandidatesStore).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: a save failure on an otherwise-open ranked-candidates store still doesn't fail discovery", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue()],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const saveRankedCandidates = vi.fn(() => {
      throw new Error("disk full mid-write");
    });

    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => ({
        dbPath: ":memory:",
        saveRankedCandidates,
        listRankedCandidates: () => [],
        close: () => undefined,
      }),
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    expect(saveRankedCandidates).toHaveBeenCalledTimes(1);
  });
});

describe("loopover-miner discover CLI entrypoint (#4247)", () => {
  it("lists the discover command in --help", () => {
    const output = runCapture(["--help", "--no-update-check"]);
    expect(output).toContain("loopover-miner discover");
  });

  it("exits 2 with a usage error when neither repo targets nor --search are given", () => {
    const output = runCapture(["discover"]);
    expect(output).toContain("Usage: loopover-miner discover");
  });
});

describe("runDiscover onResult hook (#6522)", () => {
  it("fires options.onResult with the structured result at the full-run success point, alongside exit 0", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [
        fanOutIssue({
          issueNumber: 1,
          title: "Add retry helper",
          labels: ["help wanted", "feature"],
        }),
      ],
      warnings: [],
      rateLimitRemaining: 4987,
      rateLimitResetAt: "2026-07-09T13:00:00.000Z",
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const onResult = vi.fn();

    const exitCode = await runDiscover(["acme/widgets"], {
      nowMs: NOW,
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      onResult,
    });

    expect(exitCode).toBe(0); // additive: the exit code is unchanged by the hook
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        fanOutCount: 1,
        enqueueSummary: expect.objectContaining({ enqueued: 1 }),
      }),
    );
  });

  it("fires options.onResult with the dry-run result at the dry-run success point", async () => {
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 2, title: "Fix flaky test" })],
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const onResult = vi.fn();

    const exitCode = await runDiscover(["acme/widgets", "--dry-run"], {
      nowMs: NOW,
      fetchCandidateIssuesWithSummary,
      onResult,
    });

    expect(exitCode).toBe(0);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "dry_run", fanOutCount: 1 }),
    );
  });

  it("REGRESSION: onResult never fires on the parse-error reportCliFailure branch, and the non-zero exit is unchanged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onResult = vi.fn();

    const exitCode = await runDiscover(["not-a-repo"], { onResult });

    expect(exitCode).not.toBe(0);
    expect(onResult).not.toHaveBeenCalled();
  });

  describe("eligibility filtering (#6798)", () => {
    const trustworthyProfile = {
      repoFullName: "acme/widgets",
      schemaVersion: 1,
      generatedAt: "2026-07-18T00:00:00.000Z",
      eligibilityLabels: {
        value: [{ field: "name", contains: "help wanted" }],
        confidence: "explicit",
        provenance: [{ source: "labels", detail: "help wanted" }],
      },
      exclusionLabels: {
        value: [{ field: "name", contains: "blocked" }],
        confidence: "inferred",
        provenance: [{ source: "labels", detail: "blocked" }],
      },
      prBody: { value: null, confidence: "absent", provenance: [] },
      completeness: "inferred",
    };

    function discoverWith(
      issues: ReturnType<typeof fanOutIssue>[],
      profilesByRepo: Map<string, unknown> | null,
    ) {
      const portfolioQueue = tempQueueStore();
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues,
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      return {
        portfolioQueue,
        fetchCandidateIssuesWithSummary,
        opts: {
          nowMs: NOW,
          initPortfolioQueue: () => portfolioQueue,
          initPolicyDocCache: () => tempPolicyDocCacheStore(),
          initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
          initRankedCandidatesStore: () => tempRankedCandidatesStore(),
          fetchCandidateIssuesWithSummary,
          resolveContributionProfiles: async () => profilesByRepo ?? new Map(),
        },
      };
    }

    it("excludes maintainer-only-equivalent issues, enqueuing only the eligible ones", async () => {
      const issues = [
        fanOutIssue({ issueNumber: 1, labels: ["help wanted"] }), // eligible
        fanOutIssue({ issueNumber: 2, labels: ["blocked"] }), // exclusion label
        fanOutIssue({ issueNumber: 3, labels: ["bug"] }), // missing eligibility
      ];
      const { portfolioQueue, opts } = discoverWith(
        issues,
        new Map([["acme/widgets", trustworthyProfile]]),
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const exitCode = await runDiscover(["acme/widgets", "--json"], opts);
      expect(exitCode).toBe(0);

      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(
        payload.ranked.map((e: { issueNumber: number }) => e.issueNumber),
      ).toEqual([1]);
      expect(payload.excluded).toEqual([
        {
          repoFullName: "acme/widgets",
          issueNumber: 2,
          reason: "exclusion_label",
        },
        {
          repoFullName: "acme/widgets",
          issueNumber: 3,
          reason: "missing_eligibility_label",
        },
      ]);
      // Only the eligible issue is actually enqueued.
      expect(
        portfolioQueue.listQueue("acme/widgets").map((e) => e.identifier),
      ).toEqual(["issue:1"]);
    });

    it("SAFE DEFAULT: filters nothing for a low-confidence/empty profile", async () => {
      const emptyProfile = {
        ...trustworthyProfile,
        eligibilityLabels: {
          value: null,
          confidence: "absent",
          provenance: [],
        },
      };
      const issues = [
        fanOutIssue({ issueNumber: 1, labels: ["bug"] }),
        fanOutIssue({ issueNumber: 2, labels: ["blocked"] }),
      ];
      const { opts } = discoverWith(
        issues,
        new Map([["acme/widgets", emptyProfile]]),
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await runDiscover(["acme/widgets", "--json"], opts);

      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      // Nothing excluded — a repo whose conventions AMS couldn't read never has real work silently skipped.
      expect(payload.excluded).toEqual([]);
      expect(
        payload.ranked
          .map((e: { issueNumber: number }) => e.issueNumber)
          .sort(),
      ).toEqual([1, 2]);
    });

    it("resolves conflicting eligibility+exclusion signals conservatively (exclusion wins)", async () => {
      const issues = [
        fanOutIssue({ issueNumber: 1, labels: ["help wanted", "blocked"] }),
      ];
      const { opts } = discoverWith(
        issues,
        new Map([["acme/widgets", trustworthyProfile]]),
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await runDiscover(["acme/widgets", "--json"], opts);

      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.ranked).toEqual([]);
      expect(payload.excluded).toEqual([
        {
          repoFullName: "acme/widgets",
          issueNumber: 1,
          reason: "conflicting_signals",
        },
      ]);
    });

    it("surfaces the excluded set in plain-text output too", async () => {
      const issues = [
        fanOutIssue({ issueNumber: 1, labels: ["help wanted"] }),
        fanOutIssue({ issueNumber: 2, labels: ["blocked"] }),
      ];
      const { opts } = discoverWith(
        issues,
        new Map([["acme/widgets", trustworthyProfile]]),
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await runDiscover(["acme/widgets"], opts);
      expect(String(log.mock.calls[0]?.[0])).toMatch(
        /excluded \(eligibility\): 1\n {2}acme\/widgets#2 {2}exclusion_label/,
      );
    });

    it("applies the same eligibility filter on a --dry-run, surfacing the excluded set without enqueueing", async () => {
      const issues = [
        fanOutIssue({ issueNumber: 1, labels: ["help wanted"] }),
        fanOutIssue({ issueNumber: 2, labels: ["blocked"] }),
      ];
      const { portfolioQueue, opts } = discoverWith(
        issues,
        new Map([["acme/widgets", trustworthyProfile]]),
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await runDiscover(["acme/widgets", "--dry-run", "--json"], opts);

      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.outcome).toBe("dry_run");
      expect(
        payload.ranked.map((e: { issueNumber: number }) => e.issueNumber),
      ).toEqual([1]);
      expect(payload.excluded).toEqual([
        {
          repoFullName: "acme/widgets",
          issueNumber: 2,
          reason: "exclusion_label",
        },
      ]);
      // Dry run writes nothing to the real queue.
      expect(portfolioQueue.listQueue("acme/widgets")).toEqual([]);
    });

    it("the default resolver returns an empty map (no filtering, no network) when no token is set", async () => {
      const { resolveContributionProfilesForDiscover } =
        await import("../../packages/loopover-miner/lib/discover-cli.js");
      const fetchImpl = vi.fn();
      const profiles = await resolveContributionProfilesForDiscover(
        ["acme/widgets"],
        { githubToken: "", extract: fetchImpl as never },
      );
      expect(profiles.size).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("the default resolver reads the cache and extracts on a miss when a token is present", async () => {
      const { resolveContributionProfilesForDiscover } =
        await import("../../packages/loopover-miner/lib/discover-cli.js");
      const cache = { get: vi.fn(() => null), put: vi.fn(), close: vi.fn() };
      const extract = vi.fn(async (repoFullName: string) => ({
        ...trustworthyProfile,
        repoFullName,
      }));
      const profiles = await resolveContributionProfilesForDiscover(
        ["acme/widgets"],
        {
          githubToken: "tok",
          initCache: (() => cache) as never,
          extract: extract as never,
        },
      );
      expect(extract).toHaveBeenCalledWith(
        "acme/widgets",
        expect.objectContaining({ githubToken: "tok" }),
      );
      expect(cache.put).toHaveBeenCalled();
      expect(cache.close).toHaveBeenCalled();
      expect(profiles.get("acme/widgets")).toMatchObject({
        repoFullName: "acme/widgets",
      });
    });

    it("REGRESSION: extract omits apiBaseUrl when unset and includes it when set", async () => {
      const { resolveContributionProfilesForDiscover } =
        await import("../../packages/loopover-miner/lib/discover-cli.js");
      const cache = { get: vi.fn(() => null), put: vi.fn(), close: vi.fn() };
      const extract = vi.fn(async (repoFullName: string, _opts?: Record<string, unknown>) => ({
        ...trustworthyProfile,
        repoFullName,
      }));

      await resolveContributionProfilesForDiscover(["acme/widgets"], {
        githubToken: "tok",
        initCache: (() => cache) as never,
        extract: extract as never,
      });
      expect(extract.mock.calls[0]?.[1]).toEqual({ githubToken: "tok" });
      expect(extract.mock.calls[0]?.[1]).not.toHaveProperty("apiBaseUrl");

      extract.mockClear();
      await resolveContributionProfilesForDiscover(["acme/widgets"], {
        githubToken: "tok",
        apiBaseUrl: "https://ghe.example.com/api/v3",
        initCache: (() => cache) as never,
        extract: extract as never,
      });
      expect(extract.mock.calls[0]?.[1]).toEqual({
        githubToken: "tok",
        apiBaseUrl: "https://ghe.example.com/api/v3",
      });
    });

    it("the default resolver serves a fresh cached profile without re-extracting", async () => {
      const { resolveContributionProfilesForDiscover } =
        await import("../../packages/loopover-miner/lib/discover-cli.js");
      const cache = {
        get: vi.fn(() => ({
          profile: { ...trustworthyProfile },
          fetchedAt: "x",
          stale: false,
        })),
        put: vi.fn(),
        close: vi.fn(),
      };
      const extract = vi.fn();
      await resolveContributionProfilesForDiscover(["acme/widgets"], {
        githubToken: "tok",
        initCache: (() => cache) as never,
        extract: extract as never,
      });
      expect(extract).not.toHaveBeenCalled();
    });

    describe("assignee-exclusion (#7040)", () => {
      it("excludes a candidate assigned to the repo's own owner, unconditionally enqueuing only the rest", async () => {
        const issues = [
          fanOutIssue({ issueNumber: 1, labels: ["help wanted"] }), // eligible, unassigned
          fanOutIssue({ issueNumber: 2, labels: ["help wanted"], assignees: ["acme"] }), // owner-assigned
        ];
        const { portfolioQueue, opts } = discoverWith(issues, new Map([["acme/widgets", trustworthyProfile]]));
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const exitCode = await runDiscover(["acme/widgets", "--json"], opts);
        expect(exitCode).toBe(0);

        const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(payload.ranked.map((e: { issueNumber: number }) => e.issueNumber)).toEqual([1]);
        expect(payload.excluded).toEqual([
          { repoFullName: "acme/widgets", issueNumber: 2, reason: "excluded_assignee" },
        ]);
        expect(portfolioQueue.listQueue("acme/widgets").map((e) => e.identifier)).toEqual(["issue:1"]);
      });

      it("applies even when the repo has no profile at all (not gated behind the label safe-default)", async () => {
        const issues = [fanOutIssue({ issueNumber: 1, labels: ["bug"], assignees: ["acme"] })];
        const { opts } = discoverWith(issues, null);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        await runDiscover(["acme/widgets", "--json"], opts);

        const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(payload.ranked).toEqual([]);
        expect(payload.excluded).toEqual([
          { repoFullName: "acme/widgets", issueNumber: 1, reason: "excluded_assignee" },
        ]);
      });
    });
  });
});

describe("discovery-index supplementation (#7168)", () => {
  it("never calls the discovery-index client when the plane is disabled (default), matching pre-#7168 behavior exactly", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1 })],
      warnings: [],
      rateLimitRemaining: 100,
      rateLimitResetAt: null,
    }));
    const queryDiscoveryIndex = vi.fn(async () => {
      throw new Error("must not be called when the plane is disabled");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      env: {},
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      queryDiscoveryIndex,
    });

    expect(exitCode).toBe(0);
    expect(queryDiscoveryIndex).not.toHaveBeenCalled();
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.fanOutCount).toBe(1);
  });

  it("supplements local results with deduped discovery-index candidates when enabled", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1, title: "Local candidate" })],
      warnings: [],
      rateLimitRemaining: 100,
      rateLimitResetAt: null,
    }));
    const queryDiscoveryIndex = vi.fn(async () => ({
      contractVersion: 1,
      candidates: [
        // #1 duplicates the local candidate -- local must win, this must not appear twice.
        { owner: "acme", repo: "widgets", repoFullName: "acme/widgets", issueNumber: 1, title: "Stale duplicate", labels: [], commentsCount: 0, createdAt: null, updatedAt: null, htmlUrl: null, aiPolicyAllowed: true, aiPolicySource: "none" as const },
        // #2 is genuinely new -- must be supplemented in.
        { owner: "acme", repo: "widgets", repoFullName: "acme/widgets", issueNumber: 2, title: "From the shared index", labels: ["help wanted"], commentsCount: 0, createdAt: null, updatedAt: null, htmlUrl: null, aiPolicyAllowed: true, aiPolicySource: "none" as const },
      ],
      nextCursor: null,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      env: { LOOPOVER_MINER_DISCOVERY_PLANE: "true" },
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      queryDiscoveryIndex,
    });

    expect(exitCode).toBe(0);
    expect(queryDiscoveryIndex).toHaveBeenCalledWith({ repos: ["acme/widgets"], orgs: [], searchTerms: [] }, expect.objectContaining({}));
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.fanOutCount).toBe(2);
    const titles = payload.ranked.map((entry: { issueNumber: number; title: string }) => [entry.issueNumber, entry.title]);
    expect(titles).toEqual([
      [1, "Local candidate"],
      [2, "From the shared index"],
    ]);
  });

  it("uses the --search term as the discovery-index scope in search mode", async () => {
    const portfolioQueue = tempQueueStore();
    const searchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [],
      warnings: [],
      rateLimitRemaining: 100,
      rateLimitResetAt: null,
    }));
    const queryDiscoveryIndex = vi.fn(async () => ({ contractVersion: 1, candidates: [], nextCursor: null }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runDiscover(["--search", "label:bug", "--json"], {
      nowMs: NOW,
      env: { LOOPOVER_MINER_DISCOVERY_PLANE: "true" },
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      searchCandidateIssuesWithSummary,
      queryDiscoveryIndex,
    });

    expect(queryDiscoveryIndex).toHaveBeenCalledWith({ repos: [], orgs: [], searchTerms: ["label:bug"] }, expect.objectContaining({}));
  });

  it("returns fanOut unchanged when every discovery-index candidate is a duplicate of a local result", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1, title: "Local candidate" })],
      warnings: [],
      rateLimitRemaining: 100,
      rateLimitResetAt: null,
    }));
    const queryDiscoveryIndex = vi.fn(async () => ({
      contractVersion: 1,
      candidates: [
        { owner: "acme", repo: "widgets", repoFullName: "acme/widgets", issueNumber: 1, title: "Stale duplicate", labels: [], commentsCount: 0, createdAt: null, updatedAt: null, htmlUrl: null, aiPolicyAllowed: true, aiPolicySource: "none" as const },
      ],
      nextCursor: null,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      env: { LOOPOVER_MINER_DISCOVERY_PLANE: "true" },
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      queryDiscoveryIndex,
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.fanOutCount).toBe(1);
    expect(payload.ranked.map((entry: { title: string }) => entry.title)).toEqual(["Local candidate"]);
  });

  it("falls back to the real discovery-index client when no override is injected (still a no-op without a configured URL)", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [fanOutIssue({ issueNumber: 1 })],
      warnings: [],
      rateLimitRemaining: 100,
      rateLimitResetAt: null,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      nowMs: NOW,
      // Plane enabled, but LOOPOVER_MINER_DISCOVERY_INDEX_URL deliberately unset -- the real (non-injected)
      // queryDiscoveryIndex degrades to its own no-op without ever attempting a network call.
      env: { LOOPOVER_MINER_DISCOVERY_PLANE: "true" },
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.fanOutCount).toBe(1);
  });
});
