// Attestation-evidence envelope (#8541, attested-evaluation epic) — the typed evidence seam that lets a later
// runner attach "this backtest run executed inside an attested TEE" evidence to a persisted run, without
// inventing an ad-hoc shape. This file is PURE STRUCTURAL code only: a schema type, a deterministic
// report-data binder, and a never-throwing structural validator. It performs NO cryptographic verification of
// the attestation report (that is later maintainer work in the epic), reads no IO, and adds no dependency.

import { createHash } from "node:crypto";

/** The verification outcome recorded on an envelope. Discriminated on `status`: an envelope may be captured
 *  before any verifier has run (`unverified`), or carry a verifier's pass (`verified`) / fail (`failed`)
 *  judgment. `verifiedAt` is an ISO-8601 datetime; `reason` explains a failure. */
export type AttestationVerification =
  | { status: "unverified" }
  | { status: "verified"; verifierId: string; verifiedAt: string }
  | { status: "failed"; verifierId: string; verifiedAt: string; reason: string };

/** Evidence that a run executed inside an attested environment. Structural only — the `attestationReport` is
 *  an opaque base64 blob this module never cryptographically verifies. */
export type AttestationEnvelope = {
  schemaVersion: 1;
  teeTechnology: "sev-snp" | "tdx";
  runtimeClass: string;
  measurement: string;
  reportData: string;
  attestationReport: string;
  verification: AttestationVerification;
};

/**
 * The 32-byte `reportData` an attestation report must bind to, as lowercase-hex sha256 of
 * `${corpusChecksum}:${headSha}:${baseSha}` — the same tuple that already makes a persisted run
 * third-party reproducible (#8136). Deterministic; mirrors backtest-split.ts's `createHash("sha256")` usage.
 */
export function buildAttestationReportData(binding: { corpusChecksum: string; headSha: string; baseSha: string }): string {
  return createHash("sha256").update(`${binding.corpusChecksum}:${binding.headSha}:${binding.baseSha}`).digest("hex");
}

const KNOWN_ENVELOPE_KEYS = new Set(["schemaVersion", "teeTechnology", "runtimeClass", "measurement", "reportData", "attestationReport", "verification"]);
const MEASUREMENT_RE = /^[0-9a-f]{32,128}$/;
const REPORT_DATA_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// An ISO-8601 datetime (date + time + zone). Paired with a Date.parse check so a well-shaped but impossible
// value (e.g. month 13) is still rejected -- the regex governs shape, Date.parse governs real-calendar validity.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoDateTime(value: unknown): boolean {
  return typeof value === "string" && ISO_DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function validateVerification(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("verification: must be an object");
    return;
  }
  if (value.status === "unverified") return;
  if (value.status === "verified" || value.status === "failed") {
    if (!isNonEmptyString(value.verifierId)) errors.push("verification.verifierId: must be a non-empty string");
    if (!isIsoDateTime(value.verifiedAt)) errors.push("verification.verifiedAt: must be an ISO-8601 datetime");
    if (value.status === "failed" && !isNonEmptyString(value.reason)) errors.push("verification.reason: must be a non-empty string");
    return;
  }
  errors.push('verification.status: must be "unverified", "verified", or "failed"');
}

/**
 * Structurally validate an unknown value against {@link AttestationEnvelope}. Never throws for any input
 * (null, primitives, arrays, objects with extra keys). On failure, `errors` names every failing field path;
 * on success, `envelope` is the input narrowed to the type. Structural only — no cryptographic verification.
 */
export function validateAttestationEnvelope(value: unknown): { valid: true; envelope: AttestationEnvelope } | { valid: false; errors: string[] } {
  if (!isRecord(value)) {
    return { valid: false, errors: ["envelope: must be a non-null object"] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!KNOWN_ENVELOPE_KEYS.has(key)) errors.push(`envelope: unexpected key "${key}"`);
  }
  if (value.schemaVersion !== 1) errors.push("schemaVersion: must be the literal 1");
  if (value.teeTechnology !== "sev-snp" && value.teeTechnology !== "tdx") errors.push('teeTechnology: must be "sev-snp" or "tdx"');
  if (!isNonEmptyString(value.runtimeClass) || value.runtimeClass.length > 128) errors.push("runtimeClass: must be a non-empty string of at most 128 chars");
  if (typeof value.measurement !== "string" || !MEASUREMENT_RE.test(value.measurement)) errors.push("measurement: must be 32-128 lowercase hex chars");
  if (typeof value.reportData !== "string" || !REPORT_DATA_RE.test(value.reportData)) errors.push("reportData: must be exactly 64 lowercase hex chars");
  if (typeof value.attestationReport !== "string" || value.attestationReport.length > 65536 || !BASE64_RE.test(value.attestationReport)) {
    errors.push("attestationReport: must be non-empty base64 of at most 65536 chars");
  }
  validateVerification(value.verification, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, envelope: value as AttestationEnvelope };
}
