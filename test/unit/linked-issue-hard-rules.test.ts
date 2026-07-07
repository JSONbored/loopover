import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import * as backfillModule from "../../src/github/backfill";
import { MAX_LINKED_ISSUE_NUMBERS } from "../../src/db/repositories";
import {
  DEFAULT_LINKED_ISSUE_HARD_RULES,
  evaluateLinkedIssueHardRules,
  hasVerifiableOpenLinkedIssueReference,
  loadLinkedIssueHardRules,
  mergeLinkedIssueHardRuleWithPersistedViolation,
  resolveLinkedIssueHardRule,
  resolveLinkedIssueHasOpenReference,
  type LinkedIssueFacts,
  type LinkedIssueHardRulesConfig,
} from "../../src/review/linked-issue-hard-rules";
import type { LinkedIssueFactsFetch } from "../../src/github/backfill";
import { normalizeLinkedIssueHardRulesConfig } from "../../src/review/linked-issue-hard-rules-config";
import { parseFocusManifest, resolveEffectiveSettings } from "../../src/signals/focus-manifest";
import { setLocalManifestReader } from "../../src/signals/focus-manifest-loader";
import type { RepositorySettings } from "../../src/types";

function config(overrides: Partial<LinkedIssueHardRulesConfig> = {}): LinkedIssueHardRulesConfig {
  return {
    ownerAssignedClose: "off",
    assignedIssueClose: "off",
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

afterEach(() => setLocalManifestReader(null));

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

    it("allows an assignee-author to work an owner-assigned issue", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 7, assignees: ["jsonbored", "contributor-x"] })],
        config: config({ ownerAssignedClose: "block" }),
        repoOwner: OWNER,
        prAuthorLogin: "contributor-x",
      });
      expect(result.violated).toBe(false);
    });
  });

  describe("rule 2: assigned issue", () => {
    it("fires when the linked issue is already assigned to another contributor", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 12, assignees: ["claimed-dev"] })],
        config: config({ assignedIssueClose: "block" }),
        repoOwner: OWNER,
        prAuthorLogin: "drive-by",
      });
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("#12");
      expect(result.reason).toContain("@claimed-dev");
    });

    it("does not fire when the PR author is the assignee", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 12, assignees: ["Claimed-Dev"] })],
        config: config({ assignedIssueClose: "block" }),
        repoOwner: OWNER,
        prAuthorLogin: "claimed-dev",
      });
      expect(result.violated).toBe(false);
    });

    it("is silent when the rule is off", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 12, assignees: ["claimed-dev"] })],
        config: config({ assignedIssueClose: "off" }),
        repoOwner: OWNER,
        prAuthorLogin: "drive-by",
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

    it("allows the assignee to work a maintainer-only issue", () => {
      const result = evaluateLinkedIssueHardRules({
        issues: [issue({ number: 3, labels: ["Maintainer-Only"], assignees: ["assigned-dev"] })],
        config: config({ maintainerOnlyLabelClose: "block" }),
        repoOwner: OWNER,
        prAuthorLogin: "assigned-dev",
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
            assignedIssueClose: "block",
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
      assignedIssueClose: "off",
      missingPointLabelClose: "off",
      maintainerOnlyLabelClose: "off",
      pointBearingLabels: [],
      maintainerOnlyLabels: [],
      defaultLabelRepo: false,
      verifyBeforeClose: true,
      closeDelaySeconds: 30,
    });
  });

  it("loads linked-issue hard rules from the effective private repo config", async () => {
    setLocalManifestReader(async (repoFullName) =>
      repoFullName === "owner/configured"
        ? [
            "settings:",
            "  linkedIssueHardRules:",
            "    assignedIssueClose: block",
            "    maintainerOnlyLabelClose: block",
            "    maintainerOnlyLabels:",
            "      - maintainer-only",
            "    verifyBeforeClose: false",
            "    closeDelaySeconds: 5",
          ].join("\n")
        : null,
    );
    const cfg = await loadLinkedIssueHardRules(createTestEnv(), "owner/configured");
    expect(cfg).toMatchObject({
      assignedIssueClose: "block",
      maintainerOnlyLabelClose: "block",
      maintainerOnlyLabels: ["maintainer-only"],
      verifyBeforeClose: false,
      closeDelaySeconds: 5,
    });
  });
});

describe("evaluateLinkedIssueHardRules with explicit config", () => {
  it("supports a fully enabled config for self-host config plumbing", () => {
    const cfg: LinkedIssueHardRulesConfig = {
      ownerAssignedClose: "block",
      assignedIssueClose: "block",
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
      reason: "Linked issue #9 is labeled `reserved` — it is not open for community PRs unless assigned by a maintainer.",
    });
  });

  it("normalizes malformed linked-issue hard-rule config shapes without preserving invalid label entries", () => {
    const warnings: string[] = [];
    const cfg = normalizeLinkedIssueHardRulesConfig(
      {
        assignedIssueClose: "block",
        pointBearingLabels: ["gittensor:bug", "", 1],
        maintainerOnlyLabels: "maintainer-only",
      },
      warnings,
    );

    expect(cfg.assignedIssueClose).toBe("block");
    expect(cfg.pointBearingLabels).toEqual(["gittensor:bug"]);
    expect(cfg.maintainerOnlyLabels).toEqual([]);
    expect(warnings.some((warning) => warning.includes("pointBearingLabels[1]"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("pointBearingLabels[2]"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("maintainerOnlyLabels must be an array"))).toBe(true);
  });

  it("normalizes a malformed linked-issue hard-rule top-level value back to the all-off default", () => {
    const warnings: string[] = [];

    expect(normalizeLinkedIssueHardRulesConfig([], warnings)).toEqual(DEFAULT_LINKED_ISSUE_HARD_RULES);
    expect(warnings).toEqual(["settings.linkedIssueHardRules must be an object; using the default all-off policy."]);
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

  it("treats a confirmed-nonexistent linked issue as a violation, not a silent pass (#2136)", async () => {
    // Every reference 404s with a GENUINE installation token (proven repo access) — CONFIRMED not-found, not a
    // transient error — a contributor citing a fabricated issue number must not silently satisfy the hard rule
    // the same way a genuine fetch outage fails open.
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const r = await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), ciToken: "installation-token", linkedIssues: [1, 2] }));
    expect(r?.violated).toBe(true);
    expect(r?.reason).toMatch(/could not be found/i);
  });

  it("REGRESSION: does NOT violate when every reference 404s but ciToken is unavailable (falls back to the public token) — a 404 without proven repo access is not confirmed absence", async () => {
    // GitHub also returns 404 for a real-but-inaccessible private issue, not just a genuinely nonexistent one.
    // Without a genuine ciToken, this call falls back to env.GITHUB_PUBLIC_TOKEN, which proves nothing about
    // repo access — closing the PR here would risk punishing a contributor for a real linked issue our token
    // just can't see.
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const r = await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), ciToken: undefined, linkedIssues: [1, 2] }));
    expect(r).toBeUndefined();
  });

  it("still fails open (undefined) when a linked-issue fetch fails transiently (5xx), not confirmed-nonexistent", async () => {
    vi.stubGlobal("fetch", async () => new Response("server error", { status: 500 }));
    expect(await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), ciToken: "tok", linkedIssues: [1, 2] }))).toBeUndefined();
  });

  it("fails open when the linked issues are a MIX of confirmed-not-found and a transient fetch error", async () => {
    // Cannot rule out a real, rule-violating issue behind the transient failure — must not treat this the same
    // as an all-confirmed-not-found set.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (input.toString().endsWith("/issues/1") ? new Response("missing", { status: 404 }) : new Response("server error", { status: 500 })));
    expect(await resolveLinkedIssueHardRule(args({ config: config({ ownerAssignedClose: "block" }), ciToken: "tok", linkedIssues: [1, 2] }))).toBeUndefined();
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

  it("REGRESSION: blocks a PR that links an issue assigned to someone else, but not the assignee", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString().includes("/issues/")
        ? Response.json({ number: 1, state: "open", labels: [], assignees: [{ login: "claimed-dev" }] })
        : new Response("missing", { status: 404 }),
    );
    const blocked = await resolveLinkedIssueHardRule(
      args({ config: config({ assignedIssueClose: "block" }), ciToken: "tok", body: "closes #1", linkedIssues: [1], prAuthorLogin: "drive-by" }),
    );
    expect(blocked).toEqual({
      violated: true,
      reason: "Linked issue #1 is already assigned to @claimed-dev — only the assignee or a maintainer can submit that work.",
    });

    const assignee = await resolveLinkedIssueHardRule(
      args({ config: config({ assignedIssueClose: "block" }), ciToken: "tok", body: "closes #1", linkedIssues: [1], prAuthorLogin: "claimed-dev" }),
    );
    expect(assignee).toEqual({ violated: false, reason: null });
  });

  it("derives the installation admission key from the ci token + installation id so installation reads attribute to the installation bucket, not 'unknown' (#1951 blocker)", async () => {
    const spy = vi.spyOn(backfillModule, "fetchLinkedIssueFacts").mockResolvedValue({ status: "fetch_error" });
    await resolveLinkedIssueHardRule(
      args({ config: config({ ownerAssignedClose: "block" }), ciToken: "installation-token", installationId: 143010787, linkedIssues: [7] }),
    );
    // The key is DERIVED from the token it will actually read with (so it can never drift): a non-public token +
    // finite installation id ⇒ the installation bucket, NOT undefined (which the metrics record as "unknown").
    expect(spy).toHaveBeenCalledWith(expect.anything(), "owner/repo", 7, "installation-token", "installation:143010787");
    spy.mockRestore();
  });

  it("REGRESSION: an ineligible (owner-assigned) linked issue still violates the hard rule regardless of linkedIssueGateMode -- the two are fully independent (#selfhost-linked-issue-gate-drift)", () => {
    // evaluateLinkedIssueHardRules's own input type (`{ issues, config, repoOwner }`) has no linkedIssueGateMode
    // field at all -- it structurally cannot read it. This test pins the END-TO-END behavior: fixing
    // linkedIssueGateMode's default to "advisory" (missing-issue is non-blocking by default) must never soften
    // or bypass the hard rule for a linked issue that DOES exist but is ineligible (owner-assigned here).
    const result = evaluateLinkedIssueHardRules({
      issues: [issue({ number: 9, assignees: ["jsonbored"] })],
      config: config({ ownerAssignedClose: "block" }),
      repoOwner: OWNER,
    });
    expect(result.violated).toBe(true);
    expect(result.reason).toContain("#9");

    // The gate-mode side, evaluated completely separately: a repo with no explicit override now resolves
    // linkedIssueGateMode to "advisory" (the fixed default) -- confirming the fix under test is live -- while
    // the hard-rule violation above is computed independently and is unaffected by it either way.
    const db = { linkedIssueGateMode: "advisory", requireLinkedIssue: false } as unknown as RepositorySettings;
    expect(resolveEffectiveSettings(db, parseFocusManifest(null)).linkedIssueGateMode).toBe("advisory");
  });
});

describe("mergeLinkedIssueHardRuleWithPersistedViolation (#linked-issue-hard-rule-persistence)", () => {
  const notPersisted = { violatedAt: undefined, reason: undefined };

  it("returns the live result unchanged when it is ALREADY a violation (persisted memory adds nothing new)", () => {
    const live = { violated: true, reason: "Linked issue #9 is labeled `maintainer-only` — it is not open for community PRs unless assigned by a maintainer." };
    expect(mergeLinkedIssueHardRuleWithPersistedViolation(live, notPersisted)).toBe(live);
    // A live violation's reason wins even when a DIFFERENT persisted reason also exists — freshest evidence.
    expect(
      mergeLinkedIssueHardRuleWithPersistedViolation(live, { violatedAt: "2026-06-01T00:00:00Z", reason: "a stale, different reason" }),
    ).toBe(live);
  });

  it("passes through undefined (no rule applies) when nothing is persisted", () => {
    expect(mergeLinkedIssueHardRuleWithPersistedViolation(undefined, notPersisted)).toBeUndefined();
  });

  it("passes through a clean { violated: false } result unchanged when nothing is persisted", () => {
    const clean = { violated: false, reason: null };
    expect(mergeLinkedIssueHardRuleWithPersistedViolation(clean, notPersisted)).toBe(clean);
  });

  // REGRESSION (dodge 1): a contributor edits the PR body during the flag-then-close grace window to strip the
  // "Closes #N" reference. The next pass's live re-parse then sees zero linked issues, so resolveLinkedIssueHardRule
  // returns `undefined` -- exactly like this "live" input. Without the persisted memory, clearLinkedIssueFlag
  // would remove the pending-closure label as if the violation never happened.
  it("REGRESSION (body-edit-during-grace-window): a persisted violation is enforced even when the live re-parse now finds NO linked issues at all (undefined)", () => {
    const merged = mergeLinkedIssueHardRuleWithPersistedViolation(undefined, {
      violatedAt: "2026-06-01T12:00:00Z",
      reason: "Linked issue #9 is labeled `maintainer-only` — it is not open for community PRs unless assigned by a maintainer.",
    });
    expect(merged).toEqual({
      violated: true,
      reason: "Linked issue #9 is labeled `maintainer-only` — it is not open for community PRs unless assigned by a maintainer.",
    });
  });

  // REGRESSION (dodge 2): the linked issue's LIVE state changes between the violating pass and the verification
  // pass (e.g. the assignee is removed, or the maintainer-only label is dropped) -- resolveLinkedIssueHardRule
  // re-evaluates the SAME issue number cleanly and returns `{ violated: false, reason: null }`. Without the
  // persisted memory, this is indistinguishable from "never violated" and the flag is cleared.
  it("REGRESSION (live-issue-state-change-before-re-evaluation): a persisted violation is enforced even when the live re-parse now finds the SAME issue clean", () => {
    const merged = mergeLinkedIssueHardRuleWithPersistedViolation(
      { violated: false, reason: null },
      { violatedAt: "2026-06-01T12:00:00Z", reason: "Linked issue #9 is already assigned to @claimed-dev — only the assignee or a maintainer can submit that work." },
    );
    expect(merged).toEqual({
      violated: true,
      reason: "Linked issue #9 is already assigned to @claimed-dev — only the assignee or a maintainer can submit that work.",
    });
  });

  it("falls back to the generic reason when a persisted violation carries a null/missing reason", () => {
    expect(mergeLinkedIssueHardRuleWithPersistedViolation(undefined, { violatedAt: "2026-06-01T00:00:00Z", reason: null })).toEqual({
      violated: true,
      reason: "the linked issue is not eligible for a community PR",
    });
  });
});

describe("hasVerifiableOpenLinkedIssueReference (#unlinked-issue-guardrail-followup — pure evaluator)", () => {
  const found = (state: string): LinkedIssueFactsFetch => ({ status: "found", facts: { number: 1, state, labels: [], assignees: [], authorLogin: null } });
  const notFound: LinkedIssueFactsFetch = { status: "not_found" };
  const fetchError: LinkedIssueFactsFetch = { status: "fetch_error" };

  it("fails open (true) on an empty input — the caller handles the zero-citation case separately", () => {
    expect(hasVerifiableOpenLinkedIssueReference([])).toBe(true);
  });

  it("is true when at least one linked issue is confirmed open", () => {
    expect(hasVerifiableOpenLinkedIssueReference([found("open")])).toBe(true);
    expect(hasVerifiableOpenLinkedIssueReference([found("closed"), found("open")])).toBe(true);
  });

  it("is false when every linked issue conclusively resolves to NOT open (closed or confirmed-missing), with zero ambiguity", () => {
    expect(hasVerifiableOpenLinkedIssueReference([found("closed")])).toBe(false);
    expect(hasVerifiableOpenLinkedIssueReference([notFound])).toBe(false);
    expect(hasVerifiableOpenLinkedIssueReference([found("closed"), notFound])).toBe(false);
  });

  it("fails open (true) whenever ANY result is ambiguous (fetch_error), even if none are confirmed open", () => {
    expect(hasVerifiableOpenLinkedIssueReference([fetchError])).toBe(true);
    expect(hasVerifiableOpenLinkedIssueReference([found("closed"), fetchError])).toBe(true);
    expect(hasVerifiableOpenLinkedIssueReference([notFound, fetchError])).toBe(true);
  });

  it("a confirmed-open result takes priority over an ambiguous one present in the same set", () => {
    expect(hasVerifiableOpenLinkedIssueReference([found("open"), fetchError])).toBe(true);
  });
});

describe("resolveLinkedIssueHasOpenReference (#unlinked-issue-guardrail-followup — live orchestration)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true and fetches nothing when there are no linked issues", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: [] });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails open (true) and fetches nothing when the linked-issue count exceeds the safe-verification cap (#bounded-fanout)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tooMany = Array.from({ length: MAX_LINKED_ISSUE_NUMBERS + 1 }, (_, i) => i + 1);
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: tooMany });
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still fans out normally at exactly the cap", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString().includes("/issues/") ? Response.json({ number: 1, state: "open", labels: [], assignees: [] }) : new Response("missing", { status: 404 }),
    );
    const atCap = Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, i) => i + 1);
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: atCap });
    expect(result).toBe(true);
  });

  it("returns true when the linked issue is confirmed open", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString().includes("/issues/") ? Response.json({ number: 7, state: "open", labels: [], assignees: [] }) : new Response("missing", { status: 404 }),
    );
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: [7] });
    expect(result).toBe(true);
  });

  it("returns false when the linked issue is confirmed CLOSED — the exact stale-link gaming case", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString().includes("/issues/") ? Response.json({ number: 7, state: "closed", labels: [], assignees: [] }) : new Response("missing", { status: 404 }),
    );
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: [7] });
    expect(result).toBe(false);
  });

  it("fails open (true) when the fetch errors transiently rather than confirming the issue is dead", async () => {
    vi.stubGlobal("fetch", async () => new Response("server error", { status: 500 }));
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: [7] });
    expect(result).toBe(true);
  });

  it("still resolves correctly (via the public-token fallback) when no installationId is supplied at all", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString().includes("/issues/") ? Response.json({ number: 7, state: "closed", labels: [], assignees: [] }) : new Response("missing", { status: 404 }),
    );
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: [7], installationId: null });
    expect(result).toBe(false);
  });

  it("falls back to the public token (and still resolves) when installationId is set but token minting fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      input.toString().includes("/app/installations/") ? new Response("forbidden", { status: 403 }) : input.toString().includes("/issues/") ? Response.json({ number: 7, state: "open", labels: [], assignees: [] }) : new Response("missing", { status: 404 }),
    );
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: [7], installationId: 123 });
    expect(result).toBe(true);
  });

  it("checks multiple linked issues and is true when only one of several is open", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/issues/1")) return Response.json({ number: 1, state: "closed", labels: [], assignees: [] });
      if (url.endsWith("/issues/2")) return Response.json({ number: 2, state: "open", labels: [], assignees: [] });
      return new Response("missing", { status: 404 });
    });
    const result = await resolveLinkedIssueHasOpenReference({ env: createTestEnv({}), repoFullName: "owner/repo", linkedIssues: [1, 2] });
    expect(result).toBe(true);
  });
});
