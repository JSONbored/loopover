import { describe, expect, it } from "vitest";
import { listUpstreamDriftReports, updateUpstreamDriftReportIssue, upsertUpstreamDriftReport } from "../../src/db/repositories";
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

  it("uses upstream env defaults when source metadata is omitted", async () => {
    const env = createTestEnv({
      GITTENSOR_UPSTREAM_REPO: "entrius/gittensor",
      GITTENSOR_UPSTREAM_REF: "staging",
    });
    const report = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["ALPHA"] });
    expect(report?.payload.source).toEqual({
      repo: "entrius/gittensor",
      ref: "staging",
      commitSha: null,
    });
  });

  it("falls back to baked-in upstream repo/ref when env overrides are empty", async () => {
    const env = createTestEnv({ GITTENSOR_UPSTREAM_REPO: "", GITTENSOR_UPSTREAM_REF: "" });
    const report = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["ALPHA"] });
    expect(report?.payload.source).toEqual({
      repo: "entrius/gittensor",
      ref: "test",
      commitSha: null,
    });
  });

  it("returns null when resolving with no prior drift report", async () => {
    const env = createTestEnv();
    expect(await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: [] })).toBeNull();
  });

  it("returns an already-resolved report without rewriting it", async () => {
    const env = createTestEnv();
    const fingerprint = await unmodeledScoringConstantsFingerprint();
    await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["ALPHA"] });
    await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: [] });
    const again = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: [] });
    expect(again).toMatchObject({ fingerprint, status: "resolved" });
  });

  it("truncates long unmodeled-constant lists in the summary", async () => {
    const env = createTestEnv();
    const names = Array.from({ length: 13 }, (_, index) => `CONST_${index}`);
    const report = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: names });
    expect(report?.summary).toMatch(/, …$/);
    expect(report?.severity).toBe("high");
  });

  it("looks up the stable unmodeled-constants fingerprint even when it falls off the newest-50 drift list", async () => {
    const env = createTestEnv();
    const fingerprint = await unmodeledScoringConstantsFingerprint();
    const opened = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["ALPHA"] });
    expect(opened?.fingerprint).toBe(fingerprint);

    // Push the unmodeled report out of `listUpstreamDriftReports(env, 50)`'s recency window.
    await upsertUpstreamDriftReport(env, { ...opened!, updatedAt: "2020-01-01T00:00:00.000Z" });
    for (let index = 0; index < 51; index++) {
      await upsertUpstreamDriftReport(env, {
        id: `newer-${index}`,
        fingerprint: `newer-drift-${index}`,
        severity: "low",
        status: "open",
        summary: `newer drift ${index}`,
        affectedAreas: ["registry"],
        previousRulesetId: null,
        currentRulesetId: null,
        issueNumber: null,
        issueUrl: null,
        payload: { changes: ["noop"] },
        generatedAt: "2026-06-30T00:00:00.000Z",
        updatedAt: `2026-06-30T${String(index).padStart(2, "0")}:00:00.000Z`,
      });
    }
    expect((await listUpstreamDriftReports(env, 50)).some((report) => report.fingerprint === fingerprint)).toBe(false);

    await updateUpstreamDriftReportIssue(env, fingerprint, {
      number: 811,
      url: "https://github.com/JSONbored/gittensory/issues/811",
    });
    const updated = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: ["ALPHA", "BETA"] });
    expect(updated).toMatchObject({
      id: opened!.id,
      fingerprint,
      status: "open",
      issueNumber: 811,
      issueUrl: "https://github.com/JSONbored/gittensory/issues/811",
      payload: expect.objectContaining({ unmodeledUpstreamConstants: ["ALPHA", "BETA"] }),
    });

    const resolved = await syncUnmodeledScoringConstantDrift(env, { unmodeledConstants: [] });
    expect(resolved).toMatchObject({ id: opened!.id, fingerprint, status: "resolved" });
  });
});
