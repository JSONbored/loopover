import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  QUEUE_INTELLIGENCE_AUTHOR_ROLES,
  QUEUE_INTELLIGENCE_CHECKS_STATUSES,
  QueueIntelligencePullRequestSchema,
  QueueIntelligenceRepoContextSchema,
  buildRepositorySettingsSchema,
  checkBeforeStartSchema,
  intakeIdeaSchema,
  isJsonByteLengthWithinLimit,
  killSwitchUpdateSchema,
  markNotificationsReadBodySchema,
  preflightSchema,
  settingsPreviewSchema,
  skippedPrAuditQuerySchema,
} from "@loopover/contract/api-requests";
import {
  MAX_FOCUS_MANIFEST_BYTES,
  MAX_LOCAL_SCORER_WARNING_CHARS,
  MAX_LOCAL_SCORER_WARNING_COUNT,
  MAX_NOTIFICATION_DELIVERY_ID_LENGTH,
  MAX_NOTIFICATION_MARK_READ_IDS,
  PREFLIGHT_LIMITS,
  PUBLIC_SURFACE_SKIP_REASONS,
  SCENARIO_MAX_BRANCH_REF_CHARS,
  SCENARIO_MAX_LINKED_ISSUE_NUMBERS,
  SCENARIO_MAX_REPO_FULL_NAME_CHARS,
} from "@loopover/contract";
import { validateIdeaSubmission } from "@loopover/engine";
import { MAX_NOTIFICATION_DELIVERY_ID_LENGTH as SRC_DELIVERY_ID, MAX_NOTIFICATION_MARK_READ_IDS as SRC_MARK_READ } from "../../src/db/repositories";
import { MAX_FOCUS_MANIFEST_BYTES as SRC_MANIFEST_BYTES } from "../../src/signals/focus-manifest";
import { MAX_LOCAL_SCORER_WARNING_CHARS as SRC_WARNING_CHARS, MAX_LOCAL_SCORER_WARNING_COUNT as SRC_WARNING_COUNT } from "../../src/signals/local-scorer-diagnostics";
import {
  SCENARIO_MAX_BRANCH_REF_CHARS as SRC_BRANCH_REF,
  SCENARIO_MAX_LINKED_ISSUE_NUMBERS as SRC_LINKED_ISSUES,
  SCENARIO_MAX_REPO_FULL_NAME_CHARS as SRC_REPO_NAME,
} from "../../src/scenarios/input-model";
import { PUBLIC_SURFACE_SKIP_REASONS as SRC_SKIP_REASONS } from "../../src/signals/settings-preview";
import { PREFLIGHT_LIMITS as SRC_PREFLIGHT_LIMITS } from "../../src/signals/preflight-limits";
import { DEFAULT_COMMAND_AUTHORIZATION_POLICY } from "../../src/settings/command-authorization";
import type { AuthorRole, ChecksStatus } from "../../src/queue-intelligence";

// #9750: the request schemas moved out of src/api/routes.ts into @loopover/contract, so a tool wrapping one
// of these routes references the same object instead of a copy of the shape.
//
// The bounds could not travel with them -- the contract is a zod-only leaf that cannot import the Worker or
// the engine -- so limits.ts restates them. A restatement is only safe while something fails when the two
// disagree, and a bound that drifts fails in the worst direction: a schema that rejects input the server
// would have accepted, or accepts input the server then truncates. That is what the first block pins.

describe("every restated bound still equals its original (#9750)", () => {
  it.each([
    ["MAX_NOTIFICATION_MARK_READ_IDS", MAX_NOTIFICATION_MARK_READ_IDS, SRC_MARK_READ],
    ["MAX_NOTIFICATION_DELIVERY_ID_LENGTH", MAX_NOTIFICATION_DELIVERY_ID_LENGTH, SRC_DELIVERY_ID],
    ["MAX_FOCUS_MANIFEST_BYTES", MAX_FOCUS_MANIFEST_BYTES, SRC_MANIFEST_BYTES],
    ["MAX_LOCAL_SCORER_WARNING_COUNT", MAX_LOCAL_SCORER_WARNING_COUNT, SRC_WARNING_COUNT],
    ["MAX_LOCAL_SCORER_WARNING_CHARS", MAX_LOCAL_SCORER_WARNING_CHARS, SRC_WARNING_CHARS],
    ["SCENARIO_MAX_REPO_FULL_NAME_CHARS", SCENARIO_MAX_REPO_FULL_NAME_CHARS, SRC_REPO_NAME],
    ["SCENARIO_MAX_BRANCH_REF_CHARS", SCENARIO_MAX_BRANCH_REF_CHARS, SRC_BRANCH_REF],
    ["SCENARIO_MAX_LINKED_ISSUE_NUMBERS", SCENARIO_MAX_LINKED_ISSUE_NUMBERS, SRC_LINKED_ISSUES],
  ])("%s", (_name, contractValue, sourceValue) => {
    expect(contractValue).toBe(sourceValue);
  });

  it("PUBLIC_SURFACE_SKIP_REASONS matches src/signals/settings-preview.ts exactly, order included", () => {
    expect([...PUBLIC_SURFACE_SKIP_REASONS]).toEqual([...SRC_SKIP_REASONS]);
  });

  it("PREFLIGHT_LIMITS still matches the engine's", () => {
    expect(PREFLIGHT_LIMITS).toEqual(SRC_PREFLIGHT_LIMITS);
  });

  it("the queue-intelligence enums cover exactly the union the analyzer declares", () => {
    // Typed rather than string-compared: a role added to the analyzer's union without being added here
    // stops compiling, and one added here that the analyzer does not know does too.
    const roles: readonly AuthorRole[] = QUEUE_INTELLIGENCE_AUTHOR_ROLES;
    const statuses: readonly ChecksStatus[] = QUEUE_INTELLIGENCE_CHECKS_STATUSES;
    expect(roles).toHaveLength(3);
    expect(statuses).toHaveLength(3);
  });
});

describe("routes.ts no longer declares a request schema of its own (#9750)", () => {
  it("has no z.object literal left", () => {
    // The deliverable, asserted rather than trusted: a new inline schema here is a new copy of a shape a
    // tool may already model, which is the whole class of drift this move removes.
    expect(readFileSync("src/api/routes.ts", "utf8")).not.toContain("z.object(");
  });
});

describe("the moved schemas accept and reject what they always did (#9750)", () => {
  it("bounds the notification id list at the storage limits, both sides", () => {
    expect(markNotificationsReadBodySchema.safeParse({}).success, "absent ids means mark all delivered").toBe(true);
    expect(markNotificationsReadBodySchema.safeParse({ ids: ["a"] }).success).toBe(true);
    expect(markNotificationsReadBodySchema.safeParse({ ids: Array.from({ length: MAX_NOTIFICATION_MARK_READ_IDS + 1 }, () => "a") }).success).toBe(false);
    expect(markNotificationsReadBodySchema.safeParse({ ids: ["x".repeat(MAX_NOTIFICATION_DELIVERY_ID_LENGTH + 1)] }).success).toBe(false);
  });

  it("holds preflight to the shared PREFLIGHT_LIMITS", () => {
    const base = { repoFullName: "acme/widgets", title: "t", body: "b" };
    expect(preflightSchema.safeParse(base).success).toBe(true);
    expect(preflightSchema.safeParse({ ...base, repoFullName: "a".repeat(PREFLIGHT_LIMITS.repoFullNameChars + 1) }).success).toBe(false);
    expect(preflightSchema.safeParse({ ...base, labels: Array.from({ length: PREFLIGHT_LIMITS.labels + 1 }, () => "l") }).success).toBe(false);
  });

  it("keeps intake-idea deliberately LOOSE so the engine owns the real validation", () => {
    // Every field optional on purpose: validateIdeaSubmission returns the actionable error list, so an
    // empty submission must REACH the handler rather than be rejected by the schema.
    expect(intakeIdeaSchema.safeParse({}).success).toBe(true);
    expect(intakeIdeaSchema.safeParse({ constraints: Array.from({ length: 51 }, () => "c") }).success).toBe(false);
    expect(intakeIdeaSchema.safeParse({ targetRepo: { kind: "provision" } }).success).toBe(true);
    expect(intakeIdeaSchema.safeParse({ targetRepo: { kind: "existing", repo: "acme/widgets" } }).success).toBe(true);
    expect(intakeIdeaSchema.safeParse({ targetRepo: "acme/widgets" }).success).toBe(true);
    expect(intakeIdeaSchema.safeParse({ targetRepo: 42 }).success).toBe(false);
  });

  it("#10064: malformed object targetRepo passes the schema but is rejected by validateIdeaSubmission", () => {
    const body = { targetRepo: { kind: "existing" } };
    expect(intakeIdeaSchema.safeParse(body).success).toBe(true);
    const validated = validateIdeaSubmission(body);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.errors).toContain("target_repo_required");
  });

  it("leaves check-before-start entirely optional — the repository is the path param, not the body", () => {
    expect(checkBeforeStartSchema.safeParse({}).success).toBe(true);
    expect(checkBeforeStartSchema.safeParse({ issueNumber: 12, title: "t" }).success).toBe(true);
    // Still bounded on the fields it does accept.
    expect(checkBeforeStartSchema.safeParse({ issueNumber: 0 }).success, "issue numbers start at 1").toBe(false);
    expect(checkBeforeStartSchema.safeParse({ title: "t".repeat(PREFLIGHT_LIMITS.titleChars + 1) }).success).toBe(false);
  });

  it("validates the queue-intelligence payload at its own bounds", () => {
    const pr = {
      number: 1,
      author: "acme",
      authorRole: "contributor",
      isConfirmedMiner: false,
      linkedIssue: null,
      checksStatus: "passing",
      isStale: false,
      additions: 1,
      deletions: 0,
      title: "t",
      body: "b",
      duplicateCandidates: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(QueueIntelligencePullRequestSchema.safeParse(pr).success).toBe(true);
    expect(QueueIntelligencePullRequestSchema.safeParse({ ...pr, authorRole: "overlord" }).success).toBe(false);
    expect(QueueIntelligencePullRequestSchema.safeParse({ ...pr, number: 0 }).success, "PR numbers start at 1").toBe(false);
    expect(QueueIntelligencePullRequestSchema.safeParse({ ...pr, createdAt: "yesterday" }).success).toBe(false);

    expect(QueueIntelligenceRepoContextSchema.safeParse({ totalOpenPRs: 3, avgReviewTimeDays: 1.5, maintainerWorkload: 0.5 }).success).toBe(true);
    expect(QueueIntelligenceRepoContextSchema.safeParse({ totalOpenPRs: 3, avgReviewTimeDays: 1.5, maintainerWorkload: 1.5 }).success).toBe(false);
  });

  it("is STRICT about the skipped-PR audit query, and about the reasons it will answer for", () => {
    expect(skippedPrAuditQuerySchema.safeParse({ limit: "25" }).success, "query values arrive as strings").toBe(true);
    // `.strict()`: an unknown filter would otherwise be silently ignored and quietly return the unfiltered
    // page, which reads to a caller as "there is nothing matching".
    expect(skippedPrAuditQuerySchema.safeParse({ notAFilter: "1" }).success).toBe(false);
    expect(skippedPrAuditQuerySchema.safeParse({ reason: PUBLIC_SURFACE_SKIP_REASONS[0] }).success).toBe(true);
    expect(skippedPrAuditQuerySchema.safeParse({ reason: "because_i_said_so" }).success).toBe(false);
  });

  it("accepts a settings preview with no sample, and bounds the sample it is given", () => {
    expect(settingsPreviewSchema.safeParse({}).success, "no sample means preview the defaults").toBe(true);
    expect(settingsPreviewSchema.safeParse({ sample: { authorType: "User" } }).success).toBe(true);
    expect(settingsPreviewSchema.safeParse({ sample: { authorType: "Alien" } }).success).toBe(false);
    expect(settingsPreviewSchema.safeParse({ sample: { body: null } }).success, "a PR with an empty body is real").toBe(true);
  });

  it("still requires the kill switch to say what it is doing", () => {
    expect(killSwitchUpdateSchema.safeParse({ frozen: true }).success).toBe(true);
    expect(killSwitchUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("the settings write schema keeps the engine's default (#9750)", () => {
  const schema = buildRepositorySettingsSchema(DEFAULT_COMMAND_AUTHORIZATION_POLICY);

  it("applies the ENGINE's policy when the block is omitted, not a restated copy", () => {
    // The reason this schema is a factory: its default is a twenty-key policy the engine owns, and
    // restating it in a leaf package is exactly the duplication this move removes.
    const parsed = schema.parse({});
    expect(parsed.commandAuthorization).toEqual(DEFAULT_COMMAND_AUTHORIZATION_POLICY);
  });

  it("keeps every other default the route relied on", () => {
    expect(schema.parse({})).toMatchObject({
      gatePack: "gittensor",
      aiReviewLowConfidenceDisposition: "hold_for_review",
      closeOwnerAuthors: false,
      autoLabelEnabled: true,
      requireLinkedIssue: false,
    });
  });

  it("rejects a role outside the four the policy recognises", () => {
    expect(schema.safeParse({ commandAuthorization: { default: ["maintainer"] } }).success).toBe(true);
    expect(schema.safeParse({ commandAuthorization: { default: ["overlord"] } }).success).toBe(false);
  });
});

describe("the JSON byte-budget helper (#9750)", () => {
  it("measures BYTES, not characters — a multi-byte manifest is bigger than its length", () => {
    expect(isJsonByteLengthWithinLimit({ a: "€€€" }, 100)).toBe(true);
    expect(isJsonByteLengthWithinLimit({ a: "€" }, 5)).toBe(false);
  });

  it("treats a value that cannot be serialized at all as over budget, not under", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonByteLengthWithinLimit(cyclic, 1_000_000)).toBe(false);
  });
});
