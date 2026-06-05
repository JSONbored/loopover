import { describe, expect, it } from "vitest";
import {
  buildRepoOnboardingPackPreviewForRepo,
  buildRepoOnboardingPackPreviewFromManifest,
} from "../../src/services/repo-onboarding-pack";
import { createTestEnv } from "../helpers/d1";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { parseFocusManifestContent } from "../../src/signals/focus-manifest";
import { compileRepoPolicyCompilerOutput } from "../../src/signals/repo-policy-compiler";
import {
  buildRepoOnboardingPackPreview,
  isRepoOnboardingPackPublicSafe,
  type RepoPolicyCompilerOutput,
} from "../../src/signals/onboarding-pack";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|payout|reward estimate|raw trust|trust score|public score|private reviewability|private scoreability|farming/i;

const POLICY_COMPILER_FIXTURE: RepoPolicyCompilerOutput = {
  repoFullName: "JSONbored/gittensory",
  generatedAt: "2026-06-02T12:00:00.000Z",
  contributionLanes: [
    {
      id: "direct-pr-quality",
      title: "Direct PR quality lane",
      summary: "Small pull requests that improve deterministic repo signals.",
      preferredPaths: ["src/signals/", "test/unit/"],
      discouragedPaths: ["scripts/release/"],
      validationExpectations: ["Run npm run test:ci before submission."],
      publicNotes: ["Reference accepted repository scope in the PR description."],
    },
    {
      id: "label-policy",
      title: "Label policy lane",
      summary: "Changes that make maintainer-owned labels easier to audit.",
      preferredPaths: ["src/api/", "apps/gittensory-ui/src/"],
      validationExpectations: ["Include a focused regression test for policy output."],
    },
  ],
  labelPolicy: {
    preferredLabels: ["feature", "settings", "developer-experience"],
    requiredLabels: ["maintainer-value"],
    discouragedLabels: ["needs-triage"],
    note: "Use labels to explain accepted scope, not to promise outcomes.",
  },
  validationExpectations: [
    "Run npm run test:ci before publication.",
    "Keep fixture output stable for downstream onboarding packs.",
  ],
  readinessWarnings: [
    "Confirm contribution guidance stays previewable before publication.",
    "Keep public material separated from maintainer-only context.",
  ],
  maintainerExpectations: ["Keep pull requests narrow and tied to accepted repository policy."],
  publicOutputBoundaries: [
    "Keep sensitive credentials, account secrets, compensation estimates, private maintainer evidence, and local paths out of public contribution text.",
  ],
  privateOwnerContext: [
    "Private owner note: only maintainers should see internal calibration context.",
  ],
};

describe("buildRepoOnboardingPackPreview", () => {
  it("cross-links policy compiler output into onboarding pack inputs for issue 248", () => {
    const preview = buildRepoOnboardingPackPreview(POLICY_COMPILER_FIXTURE);

    expect(preview).toMatchObject({
      repoFullName: "JSONbored/gittensory",
      generatedAt: "2026-06-02T12:00:00.000Z",
      source: "policy_compiler",
      previewOnly: true,
      publicSafe: true,
      publication: {
        status: "preview_only",
        allowed: false,
        actions: [],
      },
    });
    expect(preview.contributionLanes).toHaveLength(2);
    expect(preview.contributionLanes[0]).toMatchObject({
      id: "direct-pr-quality",
      title: "Direct PR quality lane",
      preferredPaths: ["src/signals/", "test/unit/"],
      validationExpectations: ["Run npm run test:ci before submission."],
    });
    expect(preview.labelPolicy.preferredLabels).toEqual([
      "feature",
      "settings",
      "developer-experience",
    ]);
    expect(preview.validationExpectations).toContain(
      "Keep fixture output stable for downstream onboarding packs.",
    );
    expect(preview.readinessWarnings).toContain(
      "Confirm contribution guidance stays previewable before publication.",
    );
    expect(preview.previewMarkdown).toContain("Direct PR quality lane");
    expect(preview.previewMarkdown).toContain("Label policy");
    expect(preview.previewMarkdown).toContain("Validation expectations");
    expect(preview.previewMarkdown).toContain("Readiness warnings");
  });

  it("keeps private owner context out of public onboarding material", () => {
    const preview = buildRepoOnboardingPackPreview({
      ...POLICY_COMPILER_FIXTURE,
      privateOwnerContext: [
        "Private reviewability note with wallet, hotkey, raw trust, and farming details.",
      ],
    });

    expect(preview.privateOwnerContext).toEqual({
      itemCount: 1,
      includedInPublicPreview: false,
    });
    expect(preview.previewMarkdown).not.toMatch(/Private reviewability note/i);
    expect(JSON.stringify(preview)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(isRepoOnboardingPackPublicSafe(preview)).toBe(true);
  });

  it("drops unsafe public policy text without echoing the unsafe values", () => {
    const preview = buildRepoOnboardingPackPreview({
      repoFullName: "JSONbored/gittensory",
      contributionLanes: [
        {
          title: "Wallet setup lane",
          summary: "Publish hotkey and raw trust score guidance.",
          publicNotes: ["Use farming language for public contributors."],
        },
      ],
      labelPolicy: {
        preferredLabels: ["public score estimate"],
        note: "Mention reward estimate expectations.",
      },
      validationExpectations: ["Run npm run test:ci before submission."],
      readinessWarnings: ["Do not leak private scoreability details."],
      publicOutputBoundaries: ["No wallet, hotkey, or payout text."],
      privateOwnerContext: ["This raw trust context stays private."],
    });

    expect(preview.contributionLanes).toEqual([]);
    expect(preview.labelPolicy).toMatchObject({
      preferredLabels: [],
      requiredLabels: [],
      discouragedLabels: [],
      note: null,
    });
    expect(preview.readinessWarnings).toEqual([]);
    expect(preview.publicOutputBoundaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sensitive credentials"),
      ]),
    );
    expect(preview.droppedPublicItems).toEqual(
      expect.arrayContaining([
        { field: "contributionLanes.0.title", reason: "unsafe_public_text" },
        { field: "contributionLanes.0.summary", reason: "unsafe_public_text" },
        { field: "labelPolicy.preferredLabels.0", reason: "unsafe_public_text" },
        { field: "labelPolicy.note", reason: "unsafe_public_text" },
        { field: "readinessWarnings.0", reason: "unsafe_public_text" },
        { field: "publicOutputBoundaries.0", reason: "unsafe_public_text" },
      ]),
    );
    expect(preview.previewMarkdown).toContain("Maintainer-approved work only.");
    expect(JSON.stringify(preview)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(isRepoOnboardingPackPublicSafe(preview)).toBe(true);
  });

  it("handles blank required and optional fields while keeping preview fallback safe", () => {
    const preview = buildRepoOnboardingPackPreview({
      repoFullName: "wallet/repo",
      contributionLanes: [
        {
          title: "   ",
          summary: "Empty title should drop this lane.",
        },
        {
          id: "!!!",
          title: "Docs lane",
          summary: "Accepted documentation improvements.",
        },
      ],
      labelPolicy: { note: "   " },
      validationExpectations: [],
      maintainerExpectations: [],
      publicOutputBoundaries: [],
    });

    expect(preview.contributionLanes).toEqual([
      expect.objectContaining({
        id: "lane-2",
        title: "Docs lane",
      }),
    ]);
    expect(preview.labelPolicy.note).toBeNull();
    expect(preview.validationExpectations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("repository test command"),
      ]),
    );
    expect(preview.droppedPublicItems).toEqual(
      expect.arrayContaining([
        { field: "contributionLanes.0.title", reason: "empty" },
      ]),
    );
    expect(preview.previewMarkdown).toBe(
      "Onboarding pack preview is unavailable because public text safety checks failed.",
    );
    expect(isRepoOnboardingPackPublicSafe(preview)).toBe(true);
  });

  it("compiler fixture pipeline matches buildRepoOnboardingPackPreviewFromManifest", () => {
    const manifest = parseFocusManifestContent(
      JSON.stringify({
        wantedPaths: ["src/"],
        testExpectations: ["npm run test:ci"],
        publicNotes: ["Stay advisory."],
      }),
      "repo_file",
    );
    const compiled = compileRepoPolicyCompilerOutput({
      repoFullName: "JSONbored/gittensory",
      manifest,
    });
    const fromCompiler = buildRepoOnboardingPackPreview(compiled);
    const fromService = buildRepoOnboardingPackPreviewFromManifest("JSONbored/gittensory", manifest);
    expect(fromService.preview.contributionLanes.length).toBe(fromCompiler.contributionLanes.length);
    expect(fromService.preview.publication.status).toBe("preview_only");
    expect(isRepoOnboardingPackPublicSafe(fromService.preview)).toBe(true);
  });

  it("uses stable defaults when optional policy sections are omitted", () => {
    const preview = buildRepoOnboardingPackPreview(
      {
        repoFullName: "JSONbored/gittensory",
      },
      { generatedAt: "2026-06-02T13:00:00.000Z" },
    );

    expect(preview.generatedAt).toBe("2026-06-02T13:00:00.000Z");
    expect(preview.contributionLanes).toEqual([]);
    expect(preview.previewMarkdown).toContain("Maintainer-approved work only.");
    expect(preview.validationExpectations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("repository test command"),
      ]),
    );
    expect(preview.maintainerExpectations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("small, reviewable"),
      ]),
    );
    expect(preview.publicOutputBoundaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sensitive credentials"),
        expect.stringContaining("automated GitHub action"),
      ]),
    );
    expect(preview.privateOwnerContext).toEqual({
      itemCount: 0,
      includedInPublicPreview: false,
    });
    expect(preview.droppedPublicItems).toEqual([]);
    expect(isRepoOnboardingPackPublicSafe(preview)).toBe(true);
  });
});

describe("buildRepoOnboardingPackPreviewForRepo", () => {
  it("returns preview_only pack for accepted registered repos", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(
      env,
      { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
      1,
    );
    await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?")
      .bind("JSONbored/gittensory")
      .run();
    const response = await buildRepoOnboardingPackPreviewForRepo(env, "JSONbored/gittensory");
    expect("error" in response).toBe(false);
    if ("error" in response) return;
    expect(response.accepted).toBe(true);
    expect(response.preview.previewOnly).toBe(true);
    expect(response.preview.publication.allowed).toBe(false);
    expect(isRepoOnboardingPackPublicSafe(response.preview)).toBe(true);
  });

  it("rejects onboarding pack preview for unregistered repos", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(
      env,
      { name: "unregistered", full_name: "owner/unregistered", private: false, owner: { login: "owner" } },
      1,
    );
    const response = await buildRepoOnboardingPackPreviewForRepo(env, "owner/unregistered");
    expect(response).toMatchObject({ error: "repo_not_accepted", repoFullName: "owner/unregistered" });
  });
});
