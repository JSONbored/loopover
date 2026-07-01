import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import * as backfillModule from "../../src/github/backfill";
import {
  DEFAULT_LINKED_ISSUE_HARD_RULES,
  evaluateLinkedIssueHardRules,
  loadLinkedIssueHardRules,
  resolveLinkedIssueHardRule,
  type LinkedIssueFacts,
  type LinkedIssueHardRulesConfig,
} from "../../src/review/linked-issue-hard-rules";

function config(overrides: Partial<LinkedIssueHardRulesConfig> = {}): LinkedIssueHardRulesConfig {
  return {
    ownerAssignedClose: "off",
    missingPointLabelClose: "off",
    maintainerOnlyLabelClose: "off",
    pointBearingLabels: ["gittensor:bug", "gittensor:feature", "gittensor:priority"],
    maintainerOnlyLabels: ["maintainer-only"],
    defaultLabelRepo: false,
    verifyBeforeClose: true,
    closeDelaySeconds: 30,
    ...overrides,
  };
}

function issue(overrides: Partial<LinkedIssueFacts> & { number: number }): LinkedIssueFacts {
  return { labels: [], assignees: [], state: "open", ...overrides };
}

const OWNER = "jsonbored";

describe("evaluateLinkedIssueHardRules", () => {
  it("returns no violation when every rule is off (even if every condition is met)", () => {
    const result = evaluateLinkedIssueHardRules({
      issues: [issue({ number: 1, assignees: ["jsonbored"], labels: ["maintainer-only"] })],
      config: config({ defaultLabelRepo: true }),
      repoOwner: OWNER,
    });
    expect(result).toEqual({ violated: false, reason: null });
  });

  describe("rule 1: owner-assigned", () => {
    it("fires when the issue is assigned to the owner and the rule is block", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 7, assignees: ["jsonbored"] })],
        config: config({ ownerAssignedClose: "block" }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("#7");
      expect(result.reason).toContain("assigned to the maintainer (@jsonbored)");
    });

    it("matches the owner login case-insensitively", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 7, assignees: ["JSONbored"] })],
        config: config({ ownerAssignedClose: "block" }),
        repoOwner: "jsonbored",
      });
      expect(result.violated).toBe(true);
    });

    it("is silent when the rule is off", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 7, assignees: ["jsonbored"] })],
        config: config({ ownerAssignedClose: "off" }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });

    it("does not fire when the assignee is someone other than the owner", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 7, assignees: ["contributor-x"] })],
        config: config({ ownerAssignedClose: "block" }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });
  });

  describe("rule 2: missing point-label", () => {
    it("fires only when defaultLabelRepo is true AND no point label is present", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 9, labels: ["docs"] })],
        config: config({ missingPointLabelClose: "block", defaultLabelRepo: true }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("#9");
      expect(result.reason).toContain("no point-bearing label");
    });

    it("is silent when defaultLabelRepo is false (even with no point label)", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 9, labels: ["docs"] })],
        config: config({ missingPointLabelClose: "block", defaultLabelRepo: false }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });

    it("is silent when a point label IS present", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 9, labels: ["gittensor:bug"] })],
        config: config({ missingPointLabelClose: "block", defaultLabelRepo: true }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });

    it("matches point labels case-insensitively", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 9, labels: ["GitTensor:Feature"] })],
        config: config({ missingPointLabelClose: "block", defaultLabelRepo: true }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });

    it("is silent when the rule is off", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 9, labels: ["docs"] })],
        config: config({ missingPointLabelClose: "off", defaultLabelRepo: true }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });
  });

  describe("rule 3: maintainer-only label", () => {
    it("fires when the issue carries the maintainer-only label and the rule is block", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 3, labels: ["maintainer-only"] })],
        config: config({ maintainerOnlyLabelClose: "block" }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("#3");
      expect(result.reason).toContain("maintainer-only");
    });

    it("matches the maintainer-only label case-insensitively", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 3, labels: ["Maintainer-Only"] })],
        config: config({ maintainerOnlyLabelClose: "block" }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(true);
    });

    it("is silent when the rule is off", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 3, labels: ["maintainer-only"] })],
        config: config({ maintainerOnlyLabelClose: "off" }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });
  });

  describe("issue state + multiple issues", () => {
    it("ignores CLOSED issues even when they would otherwise violate", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 5, state: "closed", labels: ["maintainer-only"], assignees: ["jsonbored"] })],
        config: config({ maintainerOnlyLabelClose: "block", ownerAssignedClose: "block" }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(false);
    });

    it("returns the FIRST violation across multiple issues", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 10, labels: ["gittensor:bug"] }), issue({ number: 11, labels: ["maintainer-only"] })],
        config: config({ maintainerOnlyLabelClose: "block", missingPointLabelClose: "block", defaultLabelRepo: true }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("#11"); // first eligible issue is clean, second trips maintainer-only
    });

    it("skips a clean open issue and finds the violation on a later one", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 20, labels: ["gittensor:feature"] }), issue({ number: 21, assignees: ["jsonbored"] })],
        config: config({ ownerAssignedClose: "block", missingPointLabelClose: "block", defaultLabelRepo: true }),
        repoOwner: OWNER,
      });
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("#21");
    });
  });
});

describe("loadLinkedIssueHardRules", () => {
  it("returns the all-off default without requiring external policy storage", async () => {
    expect(await loadLinkedIssueHardRules({} as Env, "JSONbored/gittensory")).toEqual(DEFAULT_LINKED_ISSUE_HARD_RULES);
  });

  it("ignores unrelated env data so stale hosted config cannot manufacture a close", async () => {
    const cfg = await loadLinkedIssueHardRules(
      {
        LEGACY_POLICY: {
          linkedIssueHardRules: {
            ownerAssignedClose: "block",
            missingPointLabelClose: "block",
            maintainerOnlyLabelClose: "block",
            pointBearingLabels: ["gittensor:bug"],
            maintainerOnlyLabels: ["reserved"],
            defaultLabelRepo: true,
            verifyBeforeClose: false,
            closeDelaySeconds: 0,
          },
        },
      } as unknown as Env,
      "JSONbored/gittensory",
    );
    expect(cfg).toEqual(DEFAULT_LINKED_ISSUE_HARD_RULES);
  });

  it("the default is explicitly all-off and keeps the verification timing stable", async () => {
    const cfg = await loadLinkedIssueHardRules({} as Env, "soloname");
    expect(cfg).toEqual({
      ownerAssignedClose: "off",
      missingPointLabelClose: "off",
      maintainerOnlyLabelClose: "off",
      pointBearingLabels: [],
      maintainerOnlyLabels: [],
      defaultLabelRepo: false,
      verifyBeforeClose: true,
      closeDelaySeconds: 30,
    });
  });
});

describe("evaluateLinkedIssueHardRules with explicit config", () => {
  it("supports a fully enabled config for self-host config plumbing", () => {
    const cfg: LinkedIssueHardRulesConfig = {
      ownerAssignedClose: "block",
      missingPointLabelClose: "block",
      maintainerOnlyLabelClose: "block",
      pointBearingLabels: ["gittensor:bug"],
      maintainerOnlyLabels: ["reserved"],
      defaultLabelRepo: true,
      verifyBeforeClose: true,
      closeDelaySeconds: 30,
    };
    expect(evaluateLinkedIssueHardRules({ issues: [issue({ number: 9, labels: ["reserved"] })], config: cfg, repoOwner: OWNER })).toEqual({
      violated: true,
      reason: "Linked issue #9 is labeled `maintainer-only` — it is not open for community PRs.",
    });
  });
});

describe("resolveLinkedIssueHardRule (#1144 — overflow + orchestration)", () => {
  afterEach(() => vi.unstubAllGlobals());
  // Defaults: body=null and ciToken=undefined so the `?? ""` and `?? env.GITHUB_PUBLIC_TOKEN` fallbacks are
  // exercised; tests that need the other arm pass a string body / a CI token explicitly.
  const args = (over: Record<string, unknown> = {}) => ({
    env: createTestEnv({}),
    repoFullName: "owner/repo",
    repoOwner: "owner",
    config: config(),
    body: null as string | null | undefined,
    linkedIssues: [] as number[],
    ciToken: undefined as string | undefined,
    ...over,
  });

  it("returns undefined and fetches nothing when no rule is in block mode", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolveLinkedIssueHardRule(args({ config: config(), body: "closes #1", linkedIssues: [1] }))).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flags a body that overflows the cap (>50 closing refs) as a violation, without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const body = Array.from({ length: 60 }, (_, i) => `closes #${i + 1}`).join(" ");
    const r = await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), body, linkedIssues: [1] }));
    expect(r?.violated).toBe(true);
    expect(r?.reason).toMatch(/more issues than Gittensory can safely verify/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns undefined when a rule is on but the PR links no issues (null body → no overflow)", async () => {
    expect(await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), body: null, linkedIssues: [] }))).toBeUndefined();
  });

  it("is fail-open: undefined when every fetch fails (404), with no CI token → public-token fallback", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    expect(await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), ciToken: undefined, linkedIssues: [1, 2] }))).toBeUndefined();
  });

  it("fetches with the CI token and runs the deterministic evaluator over the facts", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString().includes("/issues/")
        ? Response.json({ number: 1, state: "open", labels: [], assignees: ["owner"] })
        : new Response("missing", { status: 404 }),
    );
    const r = await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), ciToken: "tok", body: "closes #1", linkedIssues: [1] }));
    expect(r).toBeDefined();
    expect(typeof r?.violated).toBe("boolean");
  });

  it("derives the installation admission key from the ci token + installation id so installation reads attribute to the installation bucket, not 'unknown' (#1951 blocker)", async () => {
    const spy = vi.spyOn(backfillModule, "fetchLinkedIssueFacts").mockResolvedValue(undefined);
    await resolveLinkedIssueHardRule(
      args({ config: config({ ownerAssignedClose: "block" }), ciToken: "installation-token", installationId: 143010787, linkedIssues: [7] }),
    );
    // The key is DERIVED from the token it will actually read with (so it can never drift): a non-public token +
    // finite installation id ⇒ the installation bucket, NOT undefined (which the metrics record as "unknown").
    expect(spy).toHaveBeenCalledWith(expect.anything(), "owner/repo", 7, "installation-token", "installation:143010787");
    spy.mockRestore();
  });
});
