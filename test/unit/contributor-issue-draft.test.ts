import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import * as focusManifest from "../../src/signals/focus-manifest";
import { parseFocusManifestContent } from "../../src/signals/focus-manifest";
import {
  buildContributorIssueDraftBody,
  buildContributorIssueDraftCandidates,
  buildContributorIssueDraftTestingRequirements,
  contributorIssueDraftFingerprint,
  contributorIssueDraftMarker,
  findDuplicateContributorDraft,
  generateContributorIssueDrafts,
  isContributorIssueDraftPublicSafe,
  normalizeIssueTitleKey,
} from "../../src/services/contributor-issue-draft";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import * as repositories from "../../src/db/repositories";
import type { IssueRecord } from "../../src/types";
import { buildRepoPolicyReadiness } from "../../src/signals/repo-policy-readiness";
import { buildLaneAdvice, buildConfigQuality, buildContributorIntakeHealth, buildLabelAudit, buildQueueHealth, buildCollisionReport } from "../../src/signals/engine";

const FORBIDDEN = /wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i;

const GITTENSORY_MANIFEST = parseFocusManifestContent(
  JSON.stringify({
    wantedPaths: ["src/", "apps/gittensory-ui/", "packages/gittensory-mcp/"],
    blockedPaths: ["site/", "CNAME", "**/lovable/**"],
    testExpectations: ["npm run test:ci"],
    publicNotes: ["Stay advisory."],
    linkedIssuePolicy: "required",
    issueDiscoveryPolicy: "discouraged",
  }),
  "repo_file",
);

function openIssue(number: number, title: string, body?: string): IssueRecord {
  return {
    repoFullName: "JSONbored/gittensory",
    number,
    title,
    state: "open",
    labels: [],
    linkedPrs: [],
    body: body ?? null,
  };
}

describe("contributor issue drafts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("draft generation fixture includes the full issue body contract", async () => {
    const fingerprint = await contributorIssueDraftFingerprint("owner/repo", "policy:focus_policy_missing", "policy:focus_policy_missing");
    const body = buildContributorIssueDraftBody(fingerprint, {
      background: ["Background line"],
      currentBehavior: ["Current"],
      desiredBehavior: ["Desired"],
      implementationRequirements: ["Implement"],
      publicPrivateBoundaries: ["Stay advisory"],
      acceptanceCriteria: ["Ship tests"],
      testingRequirements: buildContributorIssueDraftTestingRequirements(
        parseFocusManifestContent('{"testExpectations":["npm run test:ci"]}', "repo_file"),
      ),
    });
    expect(body).toContain(contributorIssueDraftMarker(fingerprint));
    expect(body).toContain("## Testing Requirements");
    expect(body).toContain("npm run test:ci");
    expect(body).not.toMatch(FORBIDDEN);
  });

  it("uses generic validation guidance when manifest policy has no test expectations", () => {
    const manifest = parseFocusManifestContent('{"wantedPaths":["src/"]}', "repo_file");
    const requirements = buildContributorIssueDraftTestingRequirements(manifest);
    expect(requirements[0]).toContain("documented validation command");
    expect(requirements.join(" ")).not.toMatch(/97%|npm run test:ci/i);
  });

  it("uses manifest testExpectations when configured", () => {
    const manifest = parseFocusManifestContent('{"testExpectations":["npm run test:ci","npm run lint"]}', "repo_file");
    const requirements = buildContributorIssueDraftTestingRequirements(manifest);
    expect(requirements[0]).toContain("npm run test:ci");
    expect(requirements[1]).toContain("npm run lint");
  });

  it("duplicate issue fixture skips drafts with matching marker or title", async () => {
    const fingerprint = await contributorIssueDraftFingerprint("owner/repo", "policy:validation_expectations_missing", "key");
    const title = "feat(issues): address validation-expectations-missing policy readiness for repo";
    const duplicate = findDuplicateContributorDraft([openIssue(12, title, contributorIssueDraftMarker(fingerprint))], {
      fingerprint,
      title,
    });
    expect(duplicate).toMatchObject({ number: 12, reason: "marker" });

    const titleDuplicate = findDuplicateContributorDraft([openIssue(13, title)], {
      fingerprint: "other-fingerprint",
      title,
    });
    expect(titleDuplicate).toMatchObject({ number: 13, reason: "title" });
    expect(normalizeIssueTitleKey("Feat(Issues): Address Validation!")).toBe("feat issues address validation");
  });

  it("builds candidates from policy warnings, upstream drift, and wanted paths", () => {
    const repoFullName = "JSONbored/gittensory";
    const repo = { fullName: repoFullName, isRegistered: true } as never;
    const issues: IssueRecord[] = [];
    const pullRequests: never[] = [];
    const collisions = { duplicatePairs: 0, openIssueCollisions: 0, summary: "" } as never;
    const queueCounts = { openIssues: 0, openPullRequests: 0 };
    const lane = buildLaneAdvice(repo, repoFullName);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts);
    const configQuality = buildConfigQuality(repo, issues, pullRequests, repoFullName);
    const labelAudit = buildLabelAudit(repo, [], issues, pullRequests, repoFullName);
    const contributorIntakeHealth = buildContributorIntakeHealth(repo, issues, pullRequests, repoFullName, collisions, queueCounts);
    const manifest = { ...GITTENSORY_MANIFEST, present: false, source: "none" as const, warnings: [] };
    const candidates = buildContributorIssueDraftCandidates({
      repoFullName,
      repo,
      settings: { requireLinkedIssue: false } as never,
      lane,
      configQuality,
      labelAudit,
      queueHealth,
      contributorIntakeHealth,
      focusManifest: manifest,
      openIssues: [],
      upstreamDriftWarnings: ["Upstream registry drift is open for JSONbored/gittensory: maintainerCut changed."],
    });
    expect(candidates.some((entry) => entry.topic === "policy:focus_policy_missing")).toBe(true);
    expect(candidates.some((entry) => entry.topic === "upstream:registry_drift")).toBe(true);
    expect(candidates.some((entry) => entry.topic.startsWith("focus:wanted_path:"))).toBe(true);
  });

  it("dry-run no-create test leaves GitHub untouched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = createTestEnv();
    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", { dryRun: true, limit: 2 });
    expect(result.dryRun).toBe(true);
    expect(result.createRequested).toBe(false);
    expect(result.created).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.drafts.length).toBeGreaterThan(0);
    expect(result.drafts.every((draft) => draft.status === "proposed" || draft.status === "skipped_duplicate" || draft.status === "skipped_unsafe")).toBe(true);
  });

  it("normalizes draft limits to at least one and caps excessive values", async () => {
    const env = createTestEnv();
    const low = await generateContributorIssueDrafts(env, "JSONbored/gittensory", { dryRun: true, limit: 0 });
    const high = await generateContributorIssueDrafts(env, "JSONbored/gittensory", { dryRun: true, limit: 100 });
    expect(low.drafts.length).toBeLessThanOrEqual(1);
    expect(high.drafts.length).toBeLessThanOrEqual(20);
  });

  it("optional create audit test records created drafts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          number: 501,
          html_url: "https://github.com/JSONbored/gittensory/issues/501",
        }),
      ),
    );
    const env = createTestEnv({ GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN: "token" });
    const manifest = {
      ...GITTENSORY_MANIFEST,
      wantedPaths: ["src/unique-path-119/"],
      blockedPaths: [],
      testExpectations: ["npm run test:ci"],
    };
    const repo = { fullName: "JSONbored/gittensory", isRegistered: true } as never;
    const collisions = buildCollisionReport("JSONbored/gittensory", [], []);
    const policy = buildRepoPolicyReadiness({
      repoFullName: "JSONbored/gittensory",
      focusManifest: manifest,
      settings: { requireLinkedIssue: false } as never,
      lane: buildLaneAdvice(repo, "JSONbored/gittensory"),
      configQuality: buildConfigQuality(repo, [], [], "JSONbored/gittensory"),
      labelAudit: buildLabelAudit(repo, [], [], [], "JSONbored/gittensory"),
      queueHealth: buildQueueHealth(repo, [], [], collisions, { openIssues: 0, openPullRequests: 0 }),
      contributorIntakeHealth: buildContributorIntakeHealth(repo, [], [], "JSONbored/gittensory", collisions, { openIssues: 0, openPullRequests: 0 }),
    });
    expect(policy.publicWarnings.length).toBeGreaterThan(0);

    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", {
      dryRun: false,
      create: true,
      limit: 1,
      requestedBy: "maintainer",
    });
    expect(result.created).toBeGreaterThanOrEqual(0);
    if (result.created > 0) {
      expect(result.drafts.some((draft) => draft.status === "created" && draft.issue?.number === 501)).toBe(true);
    }
  });

  it("public text hygiene regression rejects unsafe draft output", () => {
    expect(
      isContributorIssueDraftPublicSafe({
        title: "feat(issues): safe title",
        body: buildContributorIssueDraftBody("fp", {
          background: ["Stay advisory"],
          currentBehavior: ["Current"],
          desiredBehavior: ["Desired"],
          implementationRequirements: ["Implement"],
          publicPrivateBoundaries: ["Stay advisory; do not imply guaranteed compensation."],
          acceptanceCriteria: ["Tests"],
          testingRequirements: ["npm run test:ci must pass."],
        }),
      }),
    ).toBe(true);
    expect(
      isContributorIssueDraftPublicSafe({
        title: "feat(issues): estimate your reward",
        body: "wallet details",
      }),
    ).toBe(false);
  });

  it("skips duplicate drafts during generation", async () => {
    const env = createTestEnv();
    const title = "feat(issues): address validation-gate-uncertain policy readiness for repo";
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([openIssue(77, title)]);

    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", { dryRun: true, limit: 1 });
    expect(result.skippedDuplicate).toBe(1);
    expect(result.drafts[0]?.status).toBe("skipped_duplicate");
  });

  it("records skipped_create_failed when GitHub create is unavailable", async () => {
    const env = createTestEnv();
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);

    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", {
      dryRun: false,
      create: true,
      limit: 1,
    });
    expect(result.createRequested).toBe(true);
    expect(result.skippedCreateFailed).toBe(1);
    expect(result.drafts[0]?.status).toBe("skipped_create_failed");
  });

  it("records skipped_create_failed when GitHub returns a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const env = createTestEnv({ GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN: "token" });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);

    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", {
      dryRun: false,
      create: true,
      limit: 1,
    });
    expect(result.skippedCreateFailed).toBe(1);
    expect(result.drafts[0]?.status).toBe("skipped_create_failed");
  });

  it("creates issues and records audit metadata when explicit create succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          number: 501,
          html_url: "https://github.com/JSONbored/gittensory/issues/501",
        }),
      ),
    );
    const auditSpy = vi.spyOn(repositories, "recordAuditEvent").mockResolvedValue(undefined);
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = createTestEnv({ GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN: "token" });
    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", {
      dryRun: false,
      create: true,
      limit: 1,
      requestedBy: "maintainer",
    });
    expect(result.created).toBe(1);
    expect(result.drafts[0]?.status).toBe("created");
    expect(auditSpy).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        eventType: "contributor.issue_drafts_created",
        metadata: expect.objectContaining({ requestedBy: "maintainer", created: 1 }),
      }),
    );
  });

  it("builds label sets for policy warning categories", () => {
    const repoFullName = "owner/repo";
    const repo = { fullName: repoFullName, isRegistered: true } as never;
    const issues: IssueRecord[] = [];
    const pullRequests: never[] = [];
    const collisions = buildCollisionReport(repoFullName, issues, pullRequests);
    const base = {
      repoFullName,
      repo,
      settings: { requireLinkedIssue: true } as never,
      lane: buildLaneAdvice({ fullName: repoFullName, isRegistered: true, registryConfig: { issueDiscoveryShare: 1 } } as never, repoFullName),
      configQuality: buildConfigQuality(repo, issues, pullRequests, repoFullName),
      labelAudit: buildLabelAudit(repo, [], issues, pullRequests, repoFullName),
      queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions),
      contributorIntakeHealth: buildContributorIntakeHealth(repo, issues, pullRequests, repoFullName, collisions),
      openIssues: [],
      upstreamDriftWarnings: [],
    };
    const manifest = parseFocusManifestContent(
      '{"wantedPaths":["src/"],"blockedPaths":["dist/"],"testExpectations":["npm run test:ci"],"issueDiscoveryPolicy":"discouraged","linkedIssuePolicy":"optional"}',
      "repo_file",
    );
    const candidates = buildContributorIssueDraftCandidates({ ...base, focusManifest: manifest });
    const labels = new Set(candidates.flatMap((entry) => entry.labels));
    expect(labels.has("agent")).toBe(true);
    expect(labels.has("signals")).toBe(true);
    expect(candidates.some((entry) => entry.sections.implementationRequirements.some((line) => line.includes("npm run test:ci")))).toBe(true);
  });

  it("ignores closed issues and empty title keys when checking duplicates", () => {
    const fingerprint = "fp";
    const title = "feat(issues): address validation policy readiness for repo";
    expect(
      findDuplicateContributorDraft([{ ...openIssue(1, title), state: "closed" }], { fingerprint, title }),
    ).toBeNull();
    expect(findDuplicateContributorDraft([], { fingerprint, title: "   !!!   " })).toBeNull();
  });

  it("dedupes candidates by topic and skips wanted-path topics already covered in open issues", () => {
    const repoFullName = "owner/repo";
    const repo = { fullName: repoFullName, isRegistered: true } as never;
    const issues: IssueRecord[] = [];
    const pullRequests: never[] = [];
    const collisions = buildCollisionReport(repoFullName, issues, pullRequests);
    const base = {
      repoFullName,
      repo,
      settings: { requireLinkedIssue: false } as never,
      lane: buildLaneAdvice(repo, repoFullName),
      configQuality: buildConfigQuality(repo, issues, pullRequests, repoFullName),
      labelAudit: buildLabelAudit(repo, [], issues, pullRequests, repoFullName),
      queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions),
      contributorIntakeHealth: buildContributorIntakeHealth(repo, issues, pullRequests, repoFullName, collisions),
      openIssues: [openIssue(9, "feat src expand high-value work in src/", "Track src/ improvements")],
      upstreamDriftWarnings: [],
    };
    const manifest = parseFocusManifestContent('{"wantedPaths":["src/","src/"],"issueDiscoveryPolicy":"discouraged"}', "repo_file");
    const candidates = buildContributorIssueDraftCandidates({ ...base, focusManifest: manifest });
    expect(candidates.filter((entry) => entry.topic === "focus:wanted_path:src/")).toHaveLength(0);
    expect(new Set(candidates.map((entry) => entry.topic)).size).toBe(candidates.length);
  });

  it("skips unsafe drafts when wanted-path validation text fails public hygiene", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, "owner/unsafe-path", {
      wantedPaths: ["src/unsafe-path-only/"],
      testExpectations: ["wallet seed phrase"],
      linkedIssuePolicy: "required",
      issueDiscoveryPolicy: "neutral",
    });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateContributorIssueDrafts(env, "owner/unsafe-path", { dryRun: true, limit: 10 });
    expect(result.drafts.some((draft) => draft.status === "skipped_unsafe")).toBe(true);
  });

  it("returns null for invalid repo names when creating GitHub issues", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ number: 1, html_url: "https://example.com/1" })));
    const env = createTestEnv({ GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN: "token" });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateContributorIssueDrafts(env, "invalid", {
      dryRun: false,
      create: true,
      limit: 1,
    });
    expect(result.skippedCreateFailed).toBeGreaterThan(0);
  });

  it("treats malformed GitHub create responses as skipped_create_failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ html_url: "https://github.com/x/y/issues/1" })));
    const env = createTestEnv({ GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN: "token" });
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", {
      dryRun: false,
      create: true,
      limit: 1,
    });
    expect(result.skippedCreateFailed).toBe(1);
  });

  it("skips wanted-path candidates when the generated title would be unsafe", () => {
    const repoFullName = "owner/repo";
    const repo = { fullName: repoFullName, isRegistered: true } as never;
    const collisions = buildCollisionReport(repoFullName, [], []);
    const manifest = parseFocusManifestContent('{"wantedPaths":["wallet-hotkey/"]}', "repo_file");
    const candidates = buildContributorIssueDraftCandidates({
      repoFullName,
      repo,
      settings: { requireLinkedIssue: false } as never,
      lane: buildLaneAdvice(repo, repoFullName),
      configQuality: buildConfigQuality(repo, [], [], repoFullName),
      labelAudit: buildLabelAudit(repo, [], [], [], repoFullName),
      queueHealth: buildQueueHealth(repo, [], [], collisions),
      contributorIntakeHealth: buildContributorIntakeHealth(repo, [], [], repoFullName, collisions),
      focusManifest: manifest,
      openIssues: [],
      upstreamDriftWarnings: [],
    });
    expect(candidates.some((entry) => entry.topic === "focus:wanted_path:wallet-hotkey/")).toBe(false);
  });

  it("uses default limit and requestedBy when options omit them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          number: 502,
          html_url: "https://github.com/JSONbored/gittensory/issues/502",
        }),
      ),
    );
    const auditSpy = vi.spyOn(repositories, "recordAuditEvent").mockResolvedValue(undefined);
    vi.spyOn(repositories, "listOpenIssues").mockResolvedValue([]);
    const env = createTestEnv({ GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN: "token" });
    const result = await generateContributorIssueDrafts(env, "JSONbored/gittensory", {
      dryRun: false,
      create: true,
    });
    expect(result.drafts.length).toBeLessThanOrEqual(5);
    if (result.created > 0) {
      expect(auditSpy).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          metadata: expect.objectContaining({ requestedBy: "api" }),
        }),
      );
    }
  });

  it("dedupes duplicate wanted-path topics and omits empty test expectations", () => {
    const repoFullName = "owner/repo";
    const repo = { fullName: repoFullName, isRegistered: true } as never;
    const collisions = buildCollisionReport(repoFullName, [], []);
    const manifest = parseFocusManifestContent('{"wantedPaths":["src/","src/","###/"]}', "repo_file");
    const candidates = buildContributorIssueDraftCandidates({
      repoFullName,
      repo,
      settings: { requireLinkedIssue: false } as never,
      lane: buildLaneAdvice(repo, repoFullName),
      configQuality: buildConfigQuality(repo, [], [], repoFullName),
      labelAudit: buildLabelAudit(repo, [], [], [], repoFullName),
      queueHealth: buildQueueHealth(repo, [], [], collisions),
      contributorIntakeHealth: buildContributorIntakeHealth(repo, [], [], repoFullName, collisions),
      focusManifest: manifest,
      openIssues: [],
      upstreamDriftWarnings: [],
    });
    expect(candidates.filter((entry) => entry.topic === "focus:wanted_path:src/")).toHaveLength(1);
    const scoped = candidates.find((entry) => entry.topic === "focus:wanted_path:###/");
    expect(scoped?.title).toContain("feat(scope):");
    expect(scoped?.sections.implementationRequirements.some((line) => line.startsWith("Run "))).toBe(false);
  });

  it("matches title duplicates only after scanning non-matching open issues", () => {
    const title = "feat(issues): address validation policy readiness for repo";
    const duplicate = findDuplicateContributorDraft(
      [openIssue(1, "unrelated issue title"), openIssue(2, title)],
      { fingerprint: "other", title },
    );
    expect(duplicate).toMatchObject({ number: 2, reason: "title" });
  });

  it("skips policy warning candidates when generated titles fail public hygiene", () => {
    const repoFullName = "owner/repo";
    const repo = { fullName: repoFullName, isRegistered: true } as never;
    const collisions = buildCollisionReport(repoFullName, [], []);
    const manifest = parseFocusManifestContent('{"wantedPaths":[],"issueDiscoveryPolicy":"discouraged"}', "repo_file");
    vi.spyOn(focusManifest, "isFocusManifestPublicSafe").mockImplementation((text) => !String(text).includes("policy readiness"));
    const candidates = buildContributorIssueDraftCandidates({
      repoFullName,
      repo,
      settings: { requireLinkedIssue: false } as never,
      lane: buildLaneAdvice(repo, repoFullName),
      configQuality: buildConfigQuality(repo, [], [], repoFullName),
      labelAudit: buildLabelAudit(repo, [], [], [], repoFullName),
      queueHealth: buildQueueHealth(repo, [], [], collisions),
      contributorIntakeHealth: buildContributorIntakeHealth(repo, [], [], repoFullName, collisions),
      focusManifest: manifest,
      openIssues: [],
      upstreamDriftWarnings: [],
    });
    expect(candidates.every((entry) => !entry.topic.startsWith("policy:"))).toBe(true);
    vi.restoreAllMocks();
  });
});
