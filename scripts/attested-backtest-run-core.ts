// Pure core for the attested backtest run (#9211, epic #8534). Decides WHETHER a run's attestation is
// acceptable and renders how it is persisted; the CLI (attested-backtest-run.ts) does the corpus read, the
// attester IO, and the D1 write. Mirrors backtest-logic-check-core.ts's pure-core / thin-IO split exactly,
// including its audit-event insert shape.
//
// The fail-closed rule lives here rather than in the CLI because it is the security-relevant decision in this
// feature: a runtime that CLAIMS a TEE must never be allowed to record a run as if attestation succeeded when
// it did not (#9211). Keeping it pure is what lets it be exhaustively tested without hardware.
import type { AttestationEnvelope } from "@loopover/engine";

import { sqlStringLiteral } from "./backtest-logic-check-core";

export const ATTESTED_BACKTEST_EVENT_TYPE = "calibration.attested_backtest_run";

/** What the runtime claims about itself, independent of what the attester actually returned. `none` is an
 *  ordinary un-attested dev run; `tee` asserts the workload believes it is inside a TEE runtime class. */
export type RuntimeAttestationClaim = "none" | "tee";

export type AttestedRunOutcome =
  /** Evidence captured and structurally valid. `attesterKind` is recorded so a sample-attested run is never
   *  mistaken for hardware evidence downstream. */
  | { status: "attested"; envelope: AttestationEnvelope; attesterKind: string }
  /** The runtime claimed a TEE and evidence was NOT obtained -- the fail-closed case. */
  | { status: "attestation_failed"; reason: string; attesterKind: string }
  /** No TEE was claimed and none was obtained: an ordinary unattested run, not a failure. */
  | { status: "unattested"; reason: string; attesterKind: string };

/**
 * Decide a run's attestation outcome from what the runtime claimed and what the attester produced.
 *
 * The asymmetry is the point (#9211): under `claim: "tee"` a missing or invalid envelope is
 * `attestation_failed` -- recorded, and non-zero-exiting at the CLI -- because a TEE runtime that cannot
 * produce evidence is either misconfigured or lying, and silently degrading it to "unattested" is exactly the
 * hole this epic exists to close. Under `claim: "none"` the same absence is simply `unattested`, so a
 * developer running the pipeline on a laptop is not told their run failed.
 *
 * PURE. Never throws: an assembly failure arrives as `assembly.ok === false` and is classified, not raised.
 */
export function decideAttestedRunOutcome(input: {
  claim: RuntimeAttestationClaim;
  attesterKind: string;
  assembly: { ok: true; envelope: AttestationEnvelope } | { ok: false; errors: string[] };
}): AttestedRunOutcome {
  if (input.assembly.ok) {
    return { status: "attested", envelope: input.assembly.envelope, attesterKind: input.attesterKind };
  }
  const reason = input.assembly.errors.join("; ");
  if (input.claim === "tee") return { status: "attestation_failed", reason, attesterKind: input.attesterKind };
  return { status: "unattested", reason, attesterKind: input.attesterKind };
}

/** Process exit code for an outcome: only the fail-closed case is non-zero, so an ordinary unattested dev run
 *  never breaks a pipeline while a TEE runtime that lost its evidence always does. */
export function attestedRunExitCode(outcome: AttestedRunOutcome): 0 | 1 {
  return outcome.status === "attestation_failed" ? 1 : 0;
}

/**
 * Render the audit-event INSERT for one attested run. Mirrors buildLogicBacktestAuditInsertSql's column set,
 * actor, and `outcome: "completed"` convention -- "completed" means "this run recorded successfully"; the
 * attestation verdict itself lives in `detail` and `metadata.attestation.status`, exactly as the sibling
 * backtest writers put their verdict in metadata rather than in the fixed outcome enum.
 */
export function buildAttestedRunAuditInsertSql(input: {
  id: string;
  targetKey: string;
  ruleId: string;
  outcome: AttestedRunOutcome;
  corpusChecksum: string;
  headSha: string;
  baseSha: string;
  runId: string;
  createdAt: string;
}): string {
  const metadataJson = JSON.stringify({
    attestation: {
      status: input.outcome.status,
      attesterKind: input.outcome.attesterKind,
      ...(input.outcome.status === "attested"
        ? { envelope: input.outcome.envelope }
        : { reason: input.outcome.reason }),
    },
    ruleId: input.ruleId,
    corpusChecksum: input.corpusChecksum,
    headSha: input.headSha,
    baseSha: input.baseSha,
    runId: input.runId,
  });
  const values = [
    sqlStringLiteral(input.id),
    sqlStringLiteral(ATTESTED_BACKTEST_EVENT_TYPE),
    "'loopover'",
    sqlStringLiteral(input.targetKey),
    "'completed'",
    sqlStringLiteral(`attested backtest for ${input.ruleId}: ${input.outcome.status} (${input.outcome.attesterKind})`),
    sqlStringLiteral(metadataJson),
    sqlStringLiteral(input.createdAt),
  ].join(", ");
  return `INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (${values})`;
}
