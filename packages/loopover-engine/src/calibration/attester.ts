// Attester seam (#9211) -- the pluggable boundary between "collect an attestation report" and "assemble the
// evidence envelope", so the attested-evaluation epic (#8534) can be built and CI-tested BEFORE any
// SEV-SNP-capable hardware exists. Confidential Containers ships a no-TEE sample-attester path for exactly
// this reason; mirroring it here means real hardware arrives as a CONFIG change (swap the Attester
// implementation) rather than as new code on the critical path.
//
// The split follows this module family's pure-core / thin-IO discipline (see threshold-backtest.ts vs
// services/threshold-backtest-run.ts): the interface, the deterministic sample implementation, and envelope
// assembly are pure and live here; a real SEV-SNP attester talks to /dev/sev-guest or a CoCo attestation
// agent and therefore lives in the I/O layer that supplies it. No IO, no randomness, no wall-clock reads --
// the sample attester derives every byte it returns from its request, so a sample run is reproducible.
//
// SAFETY: a sample-attested envelope must never be presentable as real evidence. Two independent things stop
// that: the report carries {@link SAMPLE_ATTESTATION_MAGIC} as its leading plaintext bytes (so a verifier can
// name it precisely instead of reporting a confusing signature failure), AND a sample report has no AMD
// signature chain, so cryptographic verification fails regardless. The magic is the honest error message; the
// missing chain is the actual guarantee.

import { createHash } from "node:crypto";

import {
  buildAttestationReportData,
  validateAttestationEnvelope,
  type AttestationEnvelope,
  type AttestationReportDataBinding,
  type AttestationTeeTechnology,
} from "./attestation-envelope.js";

/**
 * Leading plaintext bytes of every report {@link createSampleAttester} produces. Deliberately ASCII and
 * deliberately not a valid SEV-SNP report prefix (a real report opens with a little-endian u32 version
 * field, never this text), so detection is unambiguous in both directions.
 */
export const SAMPLE_ATTESTATION_MAGIC = "LOOPOVER-SAMPLE-ATTESTATION-v1";

/** What an attester is asked to bind and report over. `reportData` is {@link buildAttestationReportData}'s
 *  output (128 hex chars); `runtimeClass` labels the runtime image the workload ran as. */
export type AttestationCollectionRequest = {
  reportData: string;
  runtimeClass: string;
};

/** What an attester returns -- the evidence-bearing fields only. The binding fields (`reportData`, `runId`)
 *  come from the caller, not the attester, so an attester can never restate what a run committed to. */
export type AttestationCollection = {
  teeTechnology: AttestationTeeTechnology;
  measurement: string;
  attestationReport: string;
};

/**
 * The swappable boundary. `kind` is a stable identifier for the implementation ("sample", "sev-snp", ...)
 * used in logs and failure detail; `collect` is async because every real implementation performs IO.
 */
export type Attester = {
  kind: string;
  collect(request: AttestationCollectionRequest): Promise<AttestationCollection>;
};

export type SampleAttesterOptions = {
  /** Which TEE the sample impersonates, so downstream shape handling is exercised for both. Default "sev-snp". */
  teeTechnology?: AttestationTeeTechnology;
};

/**
 * A deterministic, hardware-free {@link Attester} for development and CI. Every field is derived from the
 * request by SHA-256, so the same request always yields the same collection -- which is what lets the
 * attested-run E2E assert exact bytes instead of merely "something was produced".
 *
 * NOT evidence of anything. See this module's SAFETY note.
 */
export function createSampleAttester(options: SampleAttesterOptions = {}): Attester {
  const teeTechnology = options.teeTechnology ?? "sev-snp";
  return {
    kind: "sample",
    collect(request: AttestationCollectionRequest): Promise<AttestationCollection> {
      const digest = createHash("sha256")
        .update(`${SAMPLE_ATTESTATION_MAGIC}:${request.reportData}:${request.runtimeClass}`)
        .digest("hex");
      return Promise.resolve({
        teeTechnology,
        // 64 hex chars -- inside the envelope's 32-128 measurement window for either technology.
        measurement: createHash("sha256").update(`sample-measurement:${request.runtimeClass}`).digest("hex"),
        attestationReport: Buffer.from(`${SAMPLE_ATTESTATION_MAGIC}:${digest}`, "utf8").toString("base64"),
      });
    },
  };
}

/**
 * True when `attestationReport` (base64) carries {@link SAMPLE_ATTESTATION_MAGIC}. Never throws: malformed
 * base64, empty input and non-strings all return false, because a caller asking "is this a dev artifact?"
 * about unparseable bytes wants `false`, not an exception -- the real verifier rejects those on their own
 * merits (no signature chain) with its own error.
 */
export function isSampleAttestationReport(attestationReport: unknown): boolean {
  if (typeof attestationReport !== "string" || attestationReport.length === 0) return false;
  // Buffer.from(..., "base64") is lenient (it ignores invalid characters rather than throwing), so a decode
  // that "succeeds" on garbage still can't produce the magic -- the prefix check below is what decides.
  return Buffer.from(attestationReport, "base64").toString("utf8").startsWith(SAMPLE_ATTESTATION_MAGIC);
}

export type AttestationAssemblyResult =
  | { ok: true; envelope: AttestationEnvelope }
  | { ok: false; errors: string[] };

/**
 * Bind a run, collect evidence for it, and assemble a structurally-valid {@link AttestationEnvelope}.
 * Computes `reportData` from `binding` itself rather than trusting a caller-supplied value, so the envelope's
 * commitment and the bytes the attester signed over cannot drift apart.
 *
 * Returns `{ ok: false }` -- never throws -- when the attester's collection fails to assemble into a valid
 * envelope, so a runner can record `attestation_failed` instead of crashing a completed evaluation. A
 * throwing attester (real hardware absent, agent unreachable) is likewise converted into `{ ok: false }`:
 * fail-closed is the runner's decision to record, not a stack trace to propagate. Binding-shape errors from
 * {@link buildAttestationReportData} are the deliberate exception -- those are programmer errors in the
 * caller's own inputs, and throwing loudly matches that helper's documented posture.
 */
export async function assembleAttestationEnvelope(
  attester: Attester,
  binding: AttestationReportDataBinding,
  runtimeClass: string,
): Promise<AttestationAssemblyResult> {
  const reportData = buildAttestationReportData(binding);

  let collection: AttestationCollection;
  try {
    collection = await attester.collect({ reportData, runtimeClass });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`attester(${attester.kind}): collection failed: ${reason}`] };
  }

  const validation = validateAttestationEnvelope({
    schemaVersion: 1,
    teeTechnology: collection.teeTechnology,
    runtimeClass,
    measurement: collection.measurement,
    reportData,
    runId: binding.runId,
    attestationReport: collection.attestationReport,
    // Honest default: evidence captured, nothing has checked it yet. The verifier CLI (#9212) is what
    // promotes this to verified/failed -- assembly never self-certifies.
    verification: { status: "unverified" },
  });

  if (!validation.valid) return { ok: false, errors: validation.errors };
  return { ok: true, envelope: validation.envelope };
}
