import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import {
  parseDiscoverArgs,
  renderDiscoverSummary,
  runDiscover,
  sanitizeDiscoverDisplayText,
} from "../../packages/gittensory-miner/lib/discover-cli.js";
import { bin, runCapture } from "./support/miner-cli-harness";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempQueueStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-discover-cli-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
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
    commentsCount: 1,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    htmlUrl: "https://github.com/acme/widgets/issues/1",
    aiPolicyAllowed: true as const,
    aiPolicySource: "none" as const,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseDiscoverArgs (#4247)", () => {
  it("requires either repo targets or --search", () => {
    expect(parseDiscoverArgs([])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner discover"),
    });
  });

  it("parses one or more owner/repo targets plus --json", () => {
    expect(parseDiscoverArgs(["acme/widgets", "acme/gadgets", "--json"])).toEqual({
      targets: [
        { owner: "acme", repo: "widgets" },
        { owner: "acme", repo: "gadgets" },
      ],
      search: null,
      json: true,
    });
  });

  it("parses --search as an alternative to repo targets", () => {
    expect(parseDiscoverArgs(["--search", "label:bug"])).toEqual({
      targets: [],
      search: "label:bug",
      json: false,
    });
  });

  it("rejects malformed repo targets", () => {
    expect(parseDiscoverArgs(["not-a-repo"])).toEqual({
      error: "Repository must be in owner/repo form: not-a-repo",
    });
  });

  it("rejects mixing repo targets with --search", () => {
    expect(parseDiscoverArgs(["acme/widgets", "--search", "x"])).toEqual({
      error: "Pass either repository targets or --search, not both.",
    });
  });

  it("rejects a --search flag missing its query and unknown options", () => {
    expect(parseDiscoverArgs(["--search"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner discover"),
    });
    expect(parseDiscoverArgs(["--search", "--json"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner discover"),
    });
    expect(parseDiscoverArgs(["acme/widgets", "--verbose"])).toEqual({
      error: "Unknown option: --verbose",
    });
  });
});

describe("renderDiscoverSummary (#4247)", () => {
  it("summarizes fan-out, ranking, and enqueue counts with top candidates", () => {
    const text = renderDiscoverSummary({
      fanOutCount: 2,
      warnings: [{ repoFullName: "acme/banned", stage: "policy:AI-USAGE.md", message: "denied" }],
      rateLimitRemaining: 4993,
      rateLimitResetAt: "2026-07-09T13:00:00.000Z",
      ranked: [
        { repoFullName: "acme/widgets", issueNumber: 1, title: "Add retry helper", rankScore: 0.8 },
        { repoFullName: "acme/widgets", issueNumber: 2, title: "Fix flaky test", rankScore: 0.4 },
      ],
      enqueueSummary: { enqueued: 2, skippedBelowMinRank: 0, skippedInvalid: 0, eventsAppended: 0 },
    });
    expect(text).toContain("fanned out: 2 candidate issue(s)");
    expect(text).toContain("ai-policy warnings: 1");
    expect(text).toContain("ranked: 2");
    expect(text).toContain("enqueued: 2");
    expect(text).toContain("rate-limit remaining: 4993 (resets 2026-07-09T13:00:00.000Z)");
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
      enqueueSummary: { enqueued: 1, skippedBelowMinRank: 0, skippedInvalid: 0, eventsAppended: 0 },
    });

    expect(text).toContain("normal SPOOFED: enqueued: 999 red CLICK codexe");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u202e");
    expect(text.split("\n").filter((line) => line.includes("SPOOFED"))).toHaveLength(1);
  });

  it("bounds sanitized title display text and handles nullish values", () => {
    expect(sanitizeDiscoverDisplayText(null)).toBe("");
    expect(sanitizeDiscoverDisplayText(`safe ${"x".repeat(300)}`)).toHaveLength(240);
  });

  it("reports skipped-below-min-rank counts and an empty-result message", () => {
    const withSkips = renderDiscoverSummary({
      fanOutCount: 1,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [{ repoFullName: "acme/widgets", issueNumber: 1, title: "x", rankScore: 0.1 }],
      enqueueSummary: { enqueued: 0, skippedBelowMinRank: 1, skippedInvalid: 0, eventsAppended: 0 },
    });
    expect(withSkips).toContain("skipped (below min rank): 1");

    const empty = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [],
      enqueueSummary: { enqueued: 0, skippedBelowMinRank: 0, skippedInvalid: 0, eventsAppended: 0 },
    });
    expect(empty).toContain("no candidates found.");
  });

  it("surfaces rate-limit telemetry, and reports 'unknown' when the fanout captured none (#4837)", () => {
    const withTelemetry = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: 12,
      rateLimitResetAt: "2026-07-09T13:30:00.000Z",
      ranked: [],
      enqueueSummary: { enqueued: 0, skippedBelowMinRank: 0, skippedInvalid: 0, eventsAppended: 0 },
    });
    expect(withTelemetry).toContain("rate-limit remaining: 12 (resets 2026-07-09T13:30:00.000Z)");

    // A remaining count of zero must still print the number, not fall through to "unknown".
    const throttled = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: 0,
      rateLimitResetAt: null,
      ranked: [],
      enqueueSummary: { enqueued: 0, skippedBelowMinRank: 0, skippedInvalid: 0, eventsAppended: 0 },
    });
    expect(throttled).toContain("rate-limit remaining: 0");
    expect(throttled).not.toContain("resets");

    const noTelemetry = renderDiscoverSummary({
      fanOutCount: 0,
      warnings: [],
      rateLimitRemaining: null,
      rateLimitResetAt: null,
      ranked: [],
      enqueueSummary: { enqueued: 0, skippedBelowMinRank: 0, skippedInvalid: 0, eventsAppended: 0 },
    });
    expect(noTelemetry).toContain("rate-limit remaining: unknown");
  });
});

describe("runDiscover (#4247)", () => {
  it("fans out repo targets, ranks, and enqueues into the real portfolio queue", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
      issues: [
        fanOutIssue({ issueNumber: 1, title: "Add retry helper", labels: ["help wanted", "feature"] }),
        fanOutIssue({ issueNumber: 2, title: "Fix flaky test", labels: ["help wanted"] }),
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
    expect(payload.ranked.map((entry: { issueNumber: number }) => entry.issueNumber)).toEqual([1, 2]);
    // The fanout's rate-limit telemetry is surfaced verbatim in --json output (#4837).
    expect(payload.rateLimitRemaining).toBe(4987);
    expect(payload.rateLimitResetAt).toBe("2026-07-09T13:00:00.000Z");

    const queued = portfolioQueue.listQueue("acme/widgets");
    expect(queued.map((entry) => entry.identifier).sort()).toEqual(["issue:1", "issue:2"]);
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
      fetchCandidateIssuesWithSummary,
      searchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    expect(searchCandidateIssuesWithSummary).toHaveBeenCalledWith("label:bug", "", expect.objectContaining({}));
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
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("fanned out: 1 candidate issue(s)");
    expect(text).toContain("rate-limit remaining: 3200 (resets 2026-07-09T13:00:00.000Z)");
    expect(text).toContain("top candidates:");
  });

  it("prints argument errors without opening the portfolio queue", async () => {
    const initPortfolioQueue = vi.fn(() => {
      throw new Error("must not open the queue on a parse error");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["not-a-repo"], { initPortfolioQueue });
    expect(exitCode).toBe(2);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Repository must be in owner/repo form: not-a-repo");
  });

  it("reports fan-out failures and exits non-zero without leaking the error", async () => {
    const portfolioQueue = tempQueueStore();
    const fetchCandidateIssuesWithSummary = vi.fn(async () => {
      throw new Error("github_unreachable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runDiscover(["acme/widgets"], {
      initPortfolioQueue: () => portfolioQueue,
      fetchCandidateIssuesWithSummary,
    });

    expect(exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith("github_unreachable");
  });

  it("opens and closes the default on-disk portfolio queue when no override is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-discover-cli-default-"));
    roots.push(root);
    const dbPath = join(root, "portfolio-queue.sqlite3");
    const previousDbPath = process.env.GITTENSORY_MINER_PORTFOLIO_QUEUE_DB;
    process.env.GITTENSORY_MINER_PORTFOLIO_QUEUE_DB = dbPath;
    try {
      const fetchCandidateIssuesWithSummary = vi.fn(async () => ({
        issues: [fanOutIssue({ issueNumber: 5 })],
        warnings: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const exitCode = await runDiscover(["acme/widgets"], { nowMs: NOW, fetchCandidateIssuesWithSummary });
      expect(exitCode).toBe(0);

      // runDiscover owned and closed this store itself (no initPortfolioQueue override was passed); reopening
      // the same file confirms the enqueue was actually persisted through the default code path.
      const reopened = initPortfolioQueueStore(dbPath);
      stores.push(reopened);
      expect(reopened.listQueue().map((entry) => entry.identifier)).toEqual(["issue:5"]);
    } finally {
      if (previousDbPath === undefined) delete process.env.GITTENSORY_MINER_PORTFOLIO_QUEUE_DB;
      else process.env.GITTENSORY_MINER_PORTFOLIO_QUEUE_DB = previousDbPath;
    }
  });
});

describe("gittensory-miner discover CLI entrypoint (#4247)", () => {
  it("lists the discover command in --help", () => {
    const output = runCapture(["--help", "--no-update-check"]);
    expect(output).toContain("gittensory-miner discover");
  });

  it("exits 2 with a usage error when neither repo targets nor --search are given", () => {
    const output = runCapture(["discover"]);
    expect(output).toContain("Usage: gittensory-miner discover");
  });
});
