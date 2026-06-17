import { describe, expect, it } from "vitest";
import { listUpstreamDriftReports, updateUpstreamDriftReportIssue } from "../../src/db/repositories";
import { syncUnmodeledScoringConstantDrift, unmodeledScoringConstantsFingerprint } from "../../src/upstream/unmodeled-scoring-drift";
import { createTestEnv } from "../helpers/d1";

describe("unmodeled scoring constant drift", () => {
  it("opens a stable-fingerprint drift report for unmodeled upstream constants", async () => {
    const env = createTestEnv();
    const fingerprint = await unmodeledScoringConstantsFingerprint();
    const report = await syncUnmodeledScoringConstantDrift(env, {
      unmodeledConstants: ["NOVELTY_BONUS_SCALAR", "EXTRA_WEIGHT"],
      source: { repo: "entrius/gittensor", ref: "test", commitSha: "abc123" },
    });

    expect(report).toMatchObject({
      fingerprint,
      status: "open",
      severity: "medium",
      affectedAreas: ["scoring_model"],
      summary: expect.stringContaining("NOVELTY_BONUS_SCALAR"),
      payload: expect.objectContaining({
        kind: "unmodeled_scoring_constants",
        unmodeledUpstreamConstants: ["EXTRA_WEIGHT", "NOVELTY_BONUS_SCALAR"],
      }),
    });
    expect(await listUpstreamDriftReports(env, 5)).toContainEqual(expect.objectContaining({ fingerprint, status: "open" }));
  });

  it("escalates severity when many constants are unmodeled", async () => {
    const env = createTestEnv();
    const report = await syncUnmodeledScoringConstantDrift(env, {
      unmodeledConstants: ["A", "B", "C"],
    });
    expect(report?.severity).toBe("high");
  });

  it("resolves the drift report when all constants are modeled", async () => {
    const env = createTestEnv();
    const fingerprint = await unmodeledScoringConstantsFingerprint();
    await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["NOVELTY_BONUS_SCALAR"] });
    const resolved = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: [] });
    expect(resolved).toMatchObject({ fingerprint, status: "resolved" });
  });

  it("preserves linked issue metadata across unmodeled updates", async () => {
    const env = createTestEnv();
    const fingerprint = await unmodeledScoringConstantsFingerprint();
    await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["ALPHA"] });
    await updateUpstreamDriftReportIssue(env, fingerprint, {
      number: 811,
      url: "https://github.com/JSONbored/gittensory/issues/811",
    });
    const updated = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["ALPHA", "BETA"] });
    expect(updated).toMatchObject({
      issueNumber: 811,
      issueUrl: "https://github.com/JSONbored/gittensory/issues/811",
      payload: expect.objectContaining({ unmodeledUpstreamConstants: ["ALPHA", "BETA"] }),
    });
  });
});
