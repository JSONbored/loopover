// Attestation-evidence envelope (#8541) -- the typed seam the attested-evaluation epic needs BEFORE any TEE
// infrastructure exists. A backtest run already persists `metadata.corpusChecksum` plus head/base SHAs
// (services/threshold-backtest-run.ts), which is what makes a verdict third-party reproducible for a public
// corpus. This module describes "that run executed inside an attested environment" as a shape, so the later
// runner work attaches evidence to runs instead of inventing an ad-hoc object at the call site.
//
// Deliberately pure and infrastructure-free: structural validation ONLY. Cryptographically verifying an
// attestation report (checking the TEE vendor's signature chain, measurement allow-lists, freshness) is
// separate maintainer work in the parent epic -- doing any of it here would be unreviewable scope and would
// bake a verification policy into what is meant to be a transport shape. Same purity contract as the rest of
// this module family: no IO, no randomness, no wall-clock reads.

import { createHash } from "node:crypto";

/** TEE technologies this envelope can describe. */
export type AttestationTeeTechnology = "sev-snp" | "tdx";

/** Outcome of verifying the attestation report. `unverified` is the honest default: evidence was captured
 *  but nothing has checked it yet -- distinct from `failed`, which records a verifier's negative verdict. */
export type AttestationVerification =
  | { status: "unverified" }
  | { status: "verified"; verifierId: string; verifiedAt: string }
  | { status: "failed"; verifierId: string; verifiedAt: string; reason: string };

export type AttestationEnvelope = {
  /** Literal 1 -- a future shape change bumps this rather than silently widening the current one. */
  schemaVersion: 1;
  teeTechnology: AttestationTeeTechnology;
  /** Opaque label for the runtime image/class the workload ran as. Non-empty, <= 128 chars. */
  runtimeClass: string;
  /** Launch measurement, lowercase hex, 32-128 hex chars (widths differ per TEE technology). */
  measurement: string;
  /** sha256, lowercase hex, exactly 64 chars -- see {@link buildAttestationReportData} for the binding. */
  reportData: string;
  /** The raw attestation report, base64, non-empty and <= 65536 chars. Never parsed here. */
  attestationReport: string;
  verification: AttestationVerification;
};

const TEE_TECHNOLOGIES: readonly string[] = ["sev-snp", "tdx"];
const RUNTIME_CLASS_MAX = 128;
const MEASUREMENT_MIN_HEX = 32;
const MEASUREMENT_MAX_HEX = 128;
const REPORT_DATA_HEX = 64;
const ATTESTATION_REPORT_MAX = 65536;
const LOWERCASE_HEX = /^[0-9a-f]+$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ENVELOPE_KEYS: readonly string[] = [
  "schemaVersion",
  "teeTechnology",
  "runtimeClass",
  "measurement",
  "reportData",
  "attestationReport",
  "verification",
];
const VERIFICATION_KEYS: Record<AttestationVerification["status"], readonly string[]> = {
  unverified: ["status"],
  verified: ["status", "verifierId", "verifiedAt"],
  failed: ["status", "verifierId", "verifiedAt", "reason"],
};

/**
 * The 32-byte payload a TEE binds into its attestation report, as lowercase hex: sha256 of
 * `${corpusChecksum}:${headSha}:${baseSha}`. Binding all three is what makes the report prove WHICH
 * evaluation ran (#8136) -- the corpus alone would not pin the code revision, and the SHAs alone would not
 * pin the data. Mirrors backtest-split.ts's own `createHash("sha256")` usage; no new dependency.
 */
export function buildAttestationReportData(binding: { corpusChecksum: string; headSha: string; baseSha: string }): string {
  return createHash("sha256").update(`${binding.corpusChecksum}:${binding.headSha}:${binding.baseSha}`).digest("hex");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateVerification(value: unknown, errors: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("verification: expected an object");
    return;
  }
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status !== "unverified" && status !== "verified" && status !== "failed") {
    errors.push('verification.status: expected "unverified", "verified", or "failed"');
    return;
  }
  for (const key of Object.keys(record)) {
    if (!VERIFICATION_KEYS[status].includes(key)) errors.push(`verification.${key}: unexpected key`);
  }
  if (status === "unverified") return;

  if (!nonEmptyString(record["verifierId"])) errors.push("verification.verifierId: expected a non-empty string");
  // Shape first: Date.parse alone accepts looser forms (a bare "2026-07-25" and other
  // implementation-defined fallbacks), while the regex alone would accept "2026-13-45T99:99:99Z".
  const verifiedAt = record["verifiedAt"];
  if (!nonEmptyString(verifiedAt) || !ISO_DATETIME.test(verifiedAt) || Number.isNaN(Date.parse(verifiedAt))) {
    errors.push("verification.verifiedAt: expected an ISO-8601 datetime string");
  }
  if (status === "failed" && !nonEmptyString(record["reason"])) {
    errors.push("verification.reason: expected a non-empty string");
  }
}

/**
 * Structurally validate an unknown value as an {@link AttestationEnvelope}. Never throws for ANY input --
 * `null`, primitives, arrays and objects with extra keys all return `{ valid: false }` with one error per
 * failing field path, so a caller can log exactly what was wrong with a rejected envelope. Extra keys are
 * rejected rather than ignored: this shape is persisted evidence, and silently dropping an unrecognized
 * field would lose data a future schemaVersion may depend on.
 */
export function validateAttestationEnvelope(
  value: unknown,
): { valid: true; envelope: AttestationEnvelope } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["envelope: expected an object"] };
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.includes(key)) errors.push(`${key}: unexpected key`);
  }

  if (record["schemaVersion"] !== 1) errors.push("schemaVersion: expected the literal 1");

  if (typeof record["teeTechnology"] !== "string" || !TEE_TECHNOLOGIES.includes(record["teeTechnology"])) {
    errors.push('teeTechnology: expected "sev-snp" or "tdx"');
  }

  const runtimeClass = record["runtimeClass"];
  if (!nonEmptyString(runtimeClass) || runtimeClass.length > RUNTIME_CLASS_MAX) {
    errors.push(`runtimeClass: expected a non-empty string of at most ${RUNTIME_CLASS_MAX} characters`);
  }

  const measurement = record["measurement"];
  if (
    typeof measurement !== "string" ||
    !LOWERCASE_HEX.test(measurement) ||
    measurement.length < MEASUREMENT_MIN_HEX ||
    measurement.length > MEASUREMENT_MAX_HEX
  ) {
    errors.push(`measurement: expected ${MEASUREMENT_MIN_HEX}-${MEASUREMENT_MAX_HEX} lowercase hex characters`);
  }

  const reportData = record["reportData"];
  if (typeof reportData !== "string" || reportData.length !== REPORT_DATA_HEX || !LOWERCASE_HEX.test(reportData)) {
    errors.push(`reportData: expected exactly ${REPORT_DATA_HEX} lowercase hex characters`);
  }

  const attestationReport = record["attestationReport"];
  if (
    !nonEmptyString(attestationReport) ||
    attestationReport.length > ATTESTATION_REPORT_MAX ||
    !BASE64.test(attestationReport)
  ) {
    errors.push(`attestationReport: expected non-empty base64 of at most ${ATTESTATION_REPORT_MAX} characters`);
  }

  validateVerification(record["verification"], errors);

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, envelope: record as AttestationEnvelope };
}
