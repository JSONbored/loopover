import {
  getLatestUpstreamRulesetSnapshot,
  listUpstreamDriftReports,
  upsertUpstreamDriftReport,
} from "../db/repositories";
import type { UpstreamDriftArea, UpstreamDriftReportRecord, UpstreamDriftSeverity } from "../types";
import { sha256Hex } from "../utils/crypto";
import { nowIso } from "../utils/json";

const UNMODELED_SCORING_CONSTANTS_FINGERPRINT_SEED = "gittensory:upstream:unmodeled_scoring_constants:v1";
const SCORING_MODEL_FOLLOW_UP = ["src/scoring/model.ts", "src/upstream/ruleset.ts", "test/unit/upstream-ruleset.test.ts"];

export async function unmodeledScoringConstantsFingerprint(): Promise<string> {
  return sha256Hex(UNMODELED_SCORING_CONSTANTS_FINGERPRINT_SEED);
}

export async function syncUnmodeledScoringConstantDrift(
  env: Env,
  args: {
    unmodeledConstants: string[];
    currentRulesetId?: string | null;
    source?: { repo: string; ref: string; commitSha?: string | null };
  },
): Promise<UpstreamDriftReportRecord | null> {
  const fingerprint = await unmodeledScoringConstantsFingerprint();
  const existing = (await listUpstreamDriftReports(env, 50)).find((report) => report.fingerprint === fingerprint) ?? null;
  const now = nowIso();

  if (args.unmodeledConstants.length === 0) {
    if (!existing || existing.status === "resolved") return existing;
    const resolved: UpstreamDriftReportRecord = {
      ...existing,
      status: "resolved",
      severity: "low",
      summary: "All upstream scoring constants are modeled in gittensory.",
      updatedAt: now,
      payload: {
        ...existing.payload,
        kind: "unmodeled_scoring_constants",
        unmodeledUpstreamConstants: [],
        resolvedAt: now,
      },
    };
    await upsertUpstreamDriftReport(env, resolved);
    return resolved;
  }

  const rulesetId = args.currentRulesetId ?? (await getLatestUpstreamRulesetSnapshot(env))?.id ?? null;
  const source = args.source ?? {
    repo: env.GITTENSOR_UPSTREAM_REPO || "entrius/gittensor",
    ref: env.GITTENSOR_UPSTREAM_REF || "test",
    commitSha: null,
  };
  const unmodeled = [...args.unmodeledConstants].sort();
  const summary = `Upstream defines ${unmodeled.length} scoring constant(s) gittensory does not model: ${unmodeled.slice(0, 12).join(", ")}${unmodeled.length > 12 ? ", …" : ""}`;
  const severity: UpstreamDriftSeverity = unmodeled.length >= 3 ? "high" : "medium";
  const affectedAreas: UpstreamDriftArea[] = ["scoring_model"];
  const report: UpstreamDriftReportRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    fingerprint,
    severity,
    status: "open",
    summary,
    affectedAreas,
    previousRulesetId: existing?.previousRulesetId ?? null,
    currentRulesetId: rulesetId,
    issueNumber: existing?.issueNumber ?? null,
    issueUrl: existing?.issueUrl ?? null,
    payload: {
      kind: "unmodeled_scoring_constants",
      unmodeledUpstreamConstants: unmodeled,
      changes: [`${unmodeled.length} upstream scoring constant(s) are not modeled in gittensory`],
      source,
      recommendedFollowUp: SCORING_MODEL_FOLLOW_UP,
    },
    generatedAt: existing?.generatedAt ?? now,
    updatedAt: now,
  };
  await upsertUpstreamDriftReport(env, report);
  return report;
}
