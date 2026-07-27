import { describe, expect, it } from "vitest";

import {
  ATTESTED_BACKTEST_EVENT_TYPE,
  attestedRunExitCode,
  buildAttestedRunAuditInsertSql,
  decideAttestedRunOutcome,
  type AttestedRunOutcome,
} from "../../scripts/attested-backtest-run-core";
import type { AttestationEnvelope } from "../../packages/loopover-engine/src/calibration/attestation-envelope";

const ENVELOPE: AttestationEnvelope = {
  schemaVersion: 1,
  teeTechnology: "sev-snp",
  runtimeClass: "loopover-backtest-runner",
  measurement: "a".repeat(64),
  reportData: "b".repeat(128),
  runId: "d4".repeat(16),
  attestationReport: "QUJD",
  verification: { status: "unverified" },
};

const AUDIT_INPUT = {
  id: "run-1",
  targetKey: "acme/widgets#42",
  ruleId: "linked_issue_scope_mismatch",
  corpusChecksum: "a1".repeat(32),
  headSha: "b2".repeat(20),
  baseSha: "c3".repeat(20),
  runId: "d4".repeat(16),
  createdAt: "2026-07-27T00:00:00.000Z",
};

describe("decideAttestedRunOutcome", () => {
  it("records a successful assembly as attested, carrying the attester kind forward", () => {
    const outcome = decideAttestedRunOutcome({
      claim: "tee",
      attesterKind: "sev-snp",
      assembly: { ok: true, envelope: ENVELOPE },
    });
    expect(outcome).toEqual({ status: "attested", envelope: ENVELOPE, attesterKind: "sev-snp" });
  });

  it("a sample-attested run stays labeled as such, so it can never pass for hardware evidence", () => {
    const outcome = decideAttestedRunOutcome({
      claim: "none",
      attesterKind: "sample",
      assembly: { ok: true, envelope: ENVELOPE },
    });
    expect(outcome.status).toBe("attested");
    expect(outcome.attesterKind).toBe("sample");
  });

  it("FAIL-CLOSED: a TEE-claiming runtime that produced no evidence is attestation_failed, not degraded", () => {
    const outcome = decideAttestedRunOutcome({
      claim: "tee",
      attesterKind: "sev-snp",
      assembly: { ok: false, errors: ["attester(sev-snp): collection failed: /dev/sev-guest not present"] },
    });
    expect(outcome).toEqual({
      status: "attestation_failed",
      reason: "attester(sev-snp): collection failed: /dev/sev-guest not present",
      attesterKind: "sev-snp",
    });
  });

  it("the same absence under no TEE claim is an ordinary unattested run, not a failure", () => {
    const outcome = decideAttestedRunOutcome({
      claim: "none",
      attesterKind: "sample",
      assembly: { ok: false, errors: ["measurement: expected 32-128 lowercase hex characters"] },
    });
    expect(outcome).toEqual({
      status: "unattested",
      reason: "measurement: expected 32-128 lowercase hex characters",
      attesterKind: "sample",
    });
  });

  it("joins multiple assembly errors into one reason string", () => {
    const outcome = decideAttestedRunOutcome({
      claim: "tee",
      attesterKind: "sev-snp",
      assembly: { ok: false, errors: ["measurement: bad", "reportData: bad"] },
    });
    expect(outcome.status).toBe("attestation_failed");
    if (outcome.status !== "attestation_failed") return;
    expect(outcome.reason).toBe("measurement: bad; reportData: bad");
  });
});

describe("attestedRunExitCode", () => {
  it("only the fail-closed case exits non-zero", () => {
    const attested: AttestedRunOutcome = { status: "attested", envelope: ENVELOPE, attesterKind: "sample" };
    const unattested: AttestedRunOutcome = { status: "unattested", reason: "no tee", attesterKind: "sample" };
    const failed: AttestedRunOutcome = { status: "attestation_failed", reason: "no report", attesterKind: "sev-snp" };

    expect(attestedRunExitCode(attested)).toBe(0);
    expect(attestedRunExitCode(unattested)).toBe(0);
    expect(attestedRunExitCode(failed)).toBe(1);
  });
});

describe("buildAttestedRunAuditInsertSql", () => {
  it("persists the envelope under the attested status, with the shared audit-event column set", () => {
    const sql = buildAttestedRunAuditInsertSql({
      ...AUDIT_INPUT,
      outcome: { status: "attested", envelope: ENVELOPE, attesterKind: "sev-snp" },
    });

    expect(sql).toContain("INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at)");
    expect(sql).toContain(ATTESTED_BACKTEST_EVENT_TYPE);
    // The fixed outcome enum stays "completed" (the run recorded); the verdict lives in detail + metadata.
    expect(sql).toContain("'completed'");
    expect(sql).toContain("attested backtest for linked_issue_scope_mismatch: attested (sev-snp)");

    const metadata = JSON.parse(sql.match(/'(\{"attestation".*?\})'/)?.[1]?.replace(/''/g, "'") ?? "{}");
    expect(metadata.attestation.status).toBe("attested");
    expect(metadata.attestation.envelope).toEqual(ENVELOPE);
    expect(metadata.attestation.reason).toBeUndefined();
    expect(metadata.corpusChecksum).toBe(AUDIT_INPUT.corpusChecksum);
    expect(metadata.runId).toBe(AUDIT_INPUT.runId);
  });

  it("persists the reason -- and no envelope -- for a fail-closed run", () => {
    const sql = buildAttestedRunAuditInsertSql({
      ...AUDIT_INPUT,
      outcome: { status: "attestation_failed", reason: "no report", attesterKind: "sev-snp" },
    });

    expect(sql).toContain("attested backtest for linked_issue_scope_mismatch: attestation_failed (sev-snp)");
    const metadata = JSON.parse(sql.match(/'(\{"attestation".*?\})'/)?.[1]?.replace(/''/g, "'") ?? "{}");
    expect(metadata.attestation.status).toBe("attestation_failed");
    expect(metadata.attestation.reason).toBe("no report");
    expect(metadata.attestation.envelope).toBeUndefined();
  });

  it("escapes single quotes in the rendered literals rather than breaking the statement", () => {
    const sql = buildAttestedRunAuditInsertSql({
      ...AUDIT_INPUT,
      ruleId: "rule_with_'quote",
      outcome: { status: "unattested", reason: "it's fine", attesterKind: "sample" },
    });
    expect(sql).toContain("rule_with_''quote");
    expect(sql).toContain("it''s fine");
  });
});
