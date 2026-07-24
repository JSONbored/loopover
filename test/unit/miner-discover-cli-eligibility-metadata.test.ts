import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDefaultEventLedger } from "../../packages/loopover-miner/lib/event-ledger.js";
import { initPolicyDocCacheStore } from "../../packages/loopover-miner/lib/policy-doc-cache.js";
import { initPolicyVerdictCacheStore } from "../../packages/loopover-miner/lib/policy-verdict-cache.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/loopover-miner/lib/portfolio-queue.js";
import { initRankedCandidatesStore } from "../../packages/loopover-miner/lib/ranked-candidates.js";

// Import the .ts SOURCE via a non-literal specifier so CI's `--coverage.all=false` run grades discover-cli.ts,
// not a stale post-build .js artifact (#8544, same pattern as miner-replay-snapshot.test.ts / #8510).
const DISCOVER_CLI_MODULE = "../../packages/loopover-miner/lib/discover-cli.ts";
const {
  ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES,
  ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS,
  ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS,
  buildEligibilityExclusionMetadata,
  runDiscover,
} = (await import(DISCOVER_CLI_MODULE)) as typeof import("../../packages/loopover-miner/lib/discover-cli.js");

const NOW = Date.parse("2026-07-09T12:00:00.000Z");

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

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];
let previousConfigDir: string | undefined;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-elig-meta-ledger-"));
  roots.push(root);
  previousConfigDir = process.env.LOOPOVER_MINER_CONFIG_DIR;
  process.env.LOOPOVER_MINER_CONFIG_DIR = root;
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  if (previousConfigDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
  else process.env.LOOPOVER_MINER_CONFIG_DIR = previousConfigDir;
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempQueueStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-elig-meta-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  stores.push(store);
  return store;
}

function tempPolicyDocCacheStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-elig-meta-pdc-"));
  roots.push(root);
  const store = initPolicyDocCacheStore(join(root, "policy-doc-cache.sqlite3"));
  stores.push(store);
  return store;
}

function tempPolicyVerdictCacheStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-elig-meta-pvc-"));
  roots.push(root);
  const store = initPolicyVerdictCacheStore(join(root, "policy-verdict-cache.sqlite3"));
  stores.push(store);
  return store;
}

function tempRankedCandidatesStore() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-discover-elig-meta-rc-"));
  roots.push(root);
  const store = initRankedCandidatesStore(join(root, "ranked-candidates.sqlite3"));
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
    assignees: [] as string[],
    commentsCount: 1,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    htmlUrl: "https://github.com/acme/widgets/issues/1",
    aiPolicyAllowed: true as const,
    aiPolicySource: "none" as const,
    ...overrides,
  };
}

function discoverWith(
  issues: ReturnType<typeof fanOutIssue>[],
  profilesByRepo: Map<string, unknown> | null,
  opts?: { nowMs?: number },
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
      ...(opts?.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
      initPortfolioQueue: () => portfolioQueue,
      initPolicyDocCache: () => tempPolicyDocCacheStore(),
      initPolicyVerdictCache: () => tempPolicyVerdictCacheStore(),
      initRankedCandidatesStore: () => tempRankedCandidatesStore(),
      fetchCandidateIssuesWithSummary,
      resolveContributionProfiles: async () => profilesByRepo ?? new Map(),
    },
  };
}

function labelList(count: number, prefix = "label"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

describe("buildEligibilityExclusionMetadata (#8544)", () => {
  it("records labels, assignees, and owner when all three are present", () => {
    expect(
      buildEligibilityExclusionMetadata({
        owner: "acme",
        labels: ["help wanted", "bug"],
        assignees: ["alice", "bob"],
      }),
    ).toEqual({
      owner: "acme",
      labels: ["help wanted", "bug"],
      assignees: ["alice", "bob"],
    });
  });

  it("omits each field when absent from the candidate", () => {
    expect(buildEligibilityExclusionMetadata({})).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ labels: [] })).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ assignees: [] })).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ owner: "" })).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ labels: ["bug"] })).toEqual({ labels: ["bug"] });
    expect(buildEligibilityExclusionMetadata({ assignees: ["alice"] })).toEqual({ assignees: ["alice"] });
    expect(buildEligibilityExclusionMetadata({ owner: "acme" })).toEqual({ owner: "acme" });
    expect(buildEligibilityExclusionMetadata({ labels: [null as unknown as string, "bug"] })).toEqual({
      labels: ["bug"],
    });
  });

  it("keeps exactly-max label and assignee counts without a truncated key", () => {
    expect(
      buildEligibilityExclusionMetadata({
        labels: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS),
        assignees: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES, "user"),
      }),
    ).toEqual({
      labels: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS),
      assignees: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES, "user"),
    });
  });

  it("clamps one-over-max label and assignee counts and sets truncated", () => {
    const metadata = buildEligibilityExclusionMetadata({
      labels: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS + 1),
      assignees: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES + 1, "user"),
    });
    expect(metadata?.labels).toHaveLength(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS);
    expect(metadata?.assignees).toHaveLength(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES);
    expect(metadata?.truncated).toBe(true);
  });

  it("keeps exactly-max-length strings without truncated", () => {
    const exact = "x".repeat(ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS);
    expect(
      buildEligibilityExclusionMetadata({
        owner: exact,
        labels: [exact],
        assignees: [exact],
      }),
    ).toEqual({
      owner: exact,
      labels: [exact],
      assignees: [exact],
    });
  });

  it("truncates one-over-max-length owner, label, and assignee strings and sets truncated", () => {
    const over = "y".repeat(ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS + 1);
    const expected = "y".repeat(ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS);
    expect(buildEligibilityExclusionMetadata({ owner: over })).toEqual({
      owner: expected,
      truncated: true,
    });
    expect(buildEligibilityExclusionMetadata({ labels: [over] })).toEqual({
      labels: [expected],
      truncated: true,
    });
    expect(buildEligibilityExclusionMetadata({ assignees: [over] })).toEqual({
      assignees: [expected],
      truncated: true,
    });
  });
});

describe("recordEligibilityExclusionSignals via runDiscover (#8544)", () => {
  function fakeSignalStore() {
    const fired: Array<{
      ruleId: string;
      targetKey: string;
      outcome: string;
      metadata?: Record<string, unknown>;
    }> = [];
    return {
      fired,
      store: {
        recordRuleFired: vi.fn(async (event: {
          ruleId: string;
          targetKey: string;
          outcome: string;
          metadata?: Record<string, unknown>;
        }) => {
          fired.push({
            ruleId: event.ruleId,
            targetKey: event.targetKey,
            outcome: event.outcome,
            ...(event.metadata ? { metadata: event.metadata } : {}),
          });
        }),
        recordHumanOverride: vi.fn(async () => undefined),
        queryRuleHistory: vi.fn(async () => ({ fired: [], overrides: [] })),
      },
    };
  }

  it("captures bounded candidate context in fired-event metadata on a real run", async () => {
    const issues = [
      fanOutIssue({
        issueNumber: 2,
        labels: ["blocked"],
        assignees: ["alice"],
        owner: "acme",
      }),
    ];
    const { opts } = discoverWith(issues, new Map([["acme/widgets", trustworthyProfile]]), { nowMs: NOW });
    const { fired, store } = fakeSignalStore();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], { ...opts, initSignalTrackingStore: () => store });
    expect(exitCode).toBe(0);
    expect(fired).toEqual([
      {
        ruleId: "exclusion_label",
        targetKey: "acme/widgets#issue-2",
        outcome: "exclude",
        metadata: {
          owner: "acme",
          labels: ["blocked"],
          assignees: ["alice"],
        },
      },
    ]);
  });

  it("omits metadata entirely when the excluded candidate has no capturable context", async () => {
    const issues = [
      fanOutIssue({
        issueNumber: 3,
        labels: [123 as unknown as string],
        owner: undefined,
        assignees: undefined,
      }),
    ];
    const { opts } = discoverWith(issues, new Map([["acme/widgets", trustworthyProfile]]), { nowMs: NOW });
    const { fired, store } = fakeSignalStore();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDiscover(["acme/widgets", "--json"], { ...opts, initSignalTrackingStore: () => store });
    expect(fired).toEqual([
      {
        ruleId: "missing_eligibility_label",
        targetKey: "acme/widgets#issue-3",
        outcome: "exclude",
      },
    ]);
  });

  it("records nothing when nothing was excluded", async () => {
    const issues = [fanOutIssue({ issueNumber: 1, labels: ["help wanted"] })];
    const { opts } = discoverWith(issues, new Map([["acme/widgets", trustworthyProfile]]), { nowMs: NOW });
    const { fired, store } = fakeSignalStore();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDiscover(["acme/widgets", "--json"], { ...opts, initSignalTrackingStore: () => store });
    expect(fired).toEqual([]);
    expect(store.recordRuleFired).not.toHaveBeenCalled();
  });

  it("a store-open failure degrades to a no-op rather than aborting discovery", async () => {
    const issues = [
      fanOutIssue({ issueNumber: 1, labels: ["help wanted"] }),
      fanOutIssue({ issueNumber: 2, labels: ["blocked"] }),
    ];
    const { opts } = discoverWith(issues, new Map([["acme/widgets", trustworthyProfile]]), { nowMs: NOW });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      ...opts,
      initSignalTrackingStore: () => {
        throw new Error("store unavailable");
      },
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.excluded).toHaveLength(1);
  });

  it("a per-event recording failure is swallowed and does not stop the remaining events from being recorded", async () => {
    const issues = [
      fanOutIssue({ issueNumber: 1, labels: ["help wanted"] }),
      fanOutIssue({ issueNumber: 2, labels: ["blocked"] }),
      fanOutIssue({ issueNumber: 3, labels: ["bug"] }),
    ];
    const { opts } = discoverWith(issues, new Map([["acme/widgets", trustworthyProfile]]), { nowMs: NOW });
    let calls = 0;
    const recordRuleFired = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("write failed");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runDiscover(["acme/widgets", "--json"], {
      ...opts,
      initSignalTrackingStore: () => ({
        recordRuleFired,
        recordHumanOverride: vi.fn(async () => undefined),
        queryRuleHistory: vi.fn(async () => ({ fired: [], overrides: [] })),
      }),
    });
    expect(exitCode).toBe(0);
    expect(recordRuleFired).toHaveBeenCalledTimes(2);
  });

  it("uses Date.now() when nowMs is omitted from runDiscover options", async () => {
    const issues = [fanOutIssue({ issueNumber: 2, labels: ["blocked"] })];
    const { opts } = discoverWith(issues, new Map([["acme/widgets", trustworthyProfile]]));
    const { store } = fakeSignalStore();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const exitCode = await runDiscover(["acme/widgets", "--json"], { ...opts, initSignalTrackingStore: () => store });
    expect(exitCode).toBe(0);
    expect(store.recordRuleFired).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: new Date(NOW).toISOString() }),
    );
  });
});
