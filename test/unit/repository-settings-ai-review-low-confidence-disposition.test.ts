import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #4603: aiReviewLowConfidenceDisposition is the DB-backed, dashboard-settable disposition for a sub-
// aiReviewCloseConfidence-floor ai_consensus_defect/ai_review_split finding -- one_shot (today's pre-#4603
// unconditional close) | hold_for_review (default -- routes the would-be close to manual review instead) |
// advisory_only (drops a sub-floor finding to fully non-blocking).
describe("repository_settings: aiReviewLowConfidenceDisposition default + round-trip (#4603)", () => {
  it("getRepositorySettings returns hold_for_review for a repo with no DB row at all (the shipped safe default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.aiReviewLowConfidenceDisposition).toBe("hold_for_review");
  });

  it("upsertRepositorySettings persists hold_for_review when the caller omits the field entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-field" });
    const settings = await getRepositorySettings(env, "acme/omits-field");
    expect(settings.aiReviewLowConfidenceDisposition).toBe("hold_for_review");
  });

  it("an explicit one_shot/advisory_only opt-in round-trips through a re-upsert that carries it forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", aiReviewLowConfidenceDisposition: "one_shot" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.aiReviewLowConfidenceDisposition).toBe("one_shot");
    // A true read-modify-write caller (the route-handler pattern: spread current settings, then override) must
    // carry the persisted value forward explicitly -- upsertRepositorySettings never merges against the DB row.
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.aiReviewLowConfidenceDisposition).toBe("one_shot");
  });

  it("advisory_only round-trips distinctly from one_shot, including through an UPDATE (onConflictDoUpdate) of an existing row", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/advisory-mode", aiReviewLowConfidenceDisposition: "one_shot" });
    await upsertRepositorySettings(env, { repoFullName: "acme/advisory-mode", aiReviewLowConfidenceDisposition: "advisory_only" });
    const settings = await getRepositorySettings(env, "acme/advisory-mode");
    expect(settings.aiReviewLowConfidenceDisposition).toBe("advisory_only");
  });

  it("an invalid persisted DB value fails closed to hold_for_review on read (parseAiReviewLowConfidenceDisposition's shared fallback)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET ai_review_low_confidence_disposition = ? WHERE repo_full_name = ?").bind("sometimes", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.aiReviewLowConfidenceDisposition).toBe("hold_for_review");
  });

  it("an explicit null on write falls back to hold_for_review (parseAiReviewLowConfidenceDisposition's null arm)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/explicit-null", aiReviewLowConfidenceDisposition: null });
    const settings = await getRepositorySettings(env, "acme/explicit-null");
    expect(settings.aiReviewLowConfidenceDisposition).toBe("hold_for_review");
  });
});
