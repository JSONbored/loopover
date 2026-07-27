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
//
// #9140 (schemaVersion 1, in place before any envelope is persisted -- #8537 has not shipped yet, so this is
// a pre-launch correction, not a breaking migration): two gaps fixed together.
//   1. `reportData` was a bare 32-byte SHA-256 hex digest, but SEV-SNP's `REPORT_DATA` field and TDX's
//      `REPORTDATA` are both 64 BYTES (128 hex chars) of guest-supplied data -- the digest has to be PLACED
//      into a field twice its width, and nothing specified how. See {@link buildAttestationReportData}'s
//      doc comment for the finalized layout + worked test vectors.
//   2. The binding (`corpusChecksum:headSha:baseSha`) is deterministic across runs -- the same corpus at the
//      same SHAs always produces the same `reportData`, so one genuine attested run's report could be
//      presented for any later run with an identical binding. The second half of the now-64-byte field is a
//      freshness component (a nonce or monotonic run id) tying the report to exactly one run; the envelope's
//      new `runId` field carries the plaintext value a verifier checks it against.

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
  /** The 64-byte REPORT_DATA/REPORTDATA payload, lowercase hex, exactly 128 hex chars -- see
   *  {@link buildAttestationReportData} for the binding + freshness layout. */
  reportData: string;
  /** The freshness component bound into `reportData`'s second half (as `sha256(runId)`) -- a nonce or
   *  monotonic run id, plaintext here so a verifier can recompute `sha256(runId)` and check it against
   *  `reportData.slice(64)` AND against whatever run identifier they expect (e.g. the backtest run row this
   *  evidence claims to belong to), which is what stops a genuinely-signed but STALE report from being
   *  presented for a different run. Lowercase hex, 1-128 chars -- same shape family as `measurement`. */
  runId: string;
  /** The raw attestation report, base64, non-empty and <= 65536 chars. Never parsed here. */
  attestationReport: string;
  verification: AttestationVerification;
};

const TEE_TECHNOLOGIES: readonly string[] = ["sev-snp", "tdx"];
const RUNTIME_CLASS_MAX = 128;
const MEASUREMENT_MIN_HEX = 32;
const MEASUREMENT_MAX_HEX = 128;
/** #9140: 128 hex chars = 64 bytes, matching SEV-SNP `REPORT_DATA` / TDX `REPORTDATA` exactly (was 64/32,
 *  half the required width -- see this module's header comment). */
const REPORT_DATA_HEX = 128;
const RUN_ID_MIN_HEX = 1;
const RUN_ID_MAX_HEX = 128;
const ATTESTATION_REPORT_MAX = 65536;
const LOWERCASE_HEX = /^[0-9a-f]+$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// #9140: the old `/^[A-Za-z0-9+/]+={0,2}$/` accepted a string whose length was not a multiple of 4 (e.g. 5
// base64 characters), which is not valid base64 under any padding rule. This form requires the body to be
// whole groups of 4 characters, with at most one trailing padded group (2 chars + `==`, or 3 chars + `=`).
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENVELOPE_KEYS: readonly string[] = [
  "schemaVersion",
  "teeTechnology",
  "runtimeClass",
  "measurement",
  "reportData",
  "runId",
  "attestationReport",
  "verification",
];
const VERIFICATION_KEYS: Record<AttestationVerification["status"], readonly string[]> = {
  unverified: ["status"],
  verified: ["status", "verifierId", "verifiedAt"],
  failed: ["status", "verifierId", "verifiedAt", "reason"],
};

/** The three commitment inputs {@link buildAttestationReportData} binds, plus the freshness component.
 *  `corpusChecksum` is a sha256 hex digest (64 chars, matching `BacktestCorpusManifest.checksum` /
 *  `checksumCases`'s own output shape); `headSha`/`baseSha` are git object shas (40 hex today under SHA-1,
 *  64 once a repo moves to SHA-256); `runId` is the caller's own freshness token -- a nonce or monotonic run
 *  id -- hex-encoded by the caller in whatever way is convenient (a UUID's hex form, a hex-encoded counter,
 *  raw random bytes). Constraining all four to their expected hex shapes (rather than joining raw,
 *  unconstrained strings with `:`) is what makes the binding unambiguous: a `:` cannot appear inside a
 *  validated hex string, so no input can inject a colon and make two different (checksum, sha, sha, runId)
 *  quadruples collide on the same joined text. */
export type AttestationReportDataBinding = {
  corpusChecksum: string;
  headSha: string;
  baseSha: string;
  runId: string;
};

const CORPUS_CHECKSUM_SHAPE = /^[0-9a-f]{64}$/;
const GIT_SHA_SHAPE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_ID_SHAPE = /^[0-9a-f]{1,128}$/;

function requireShape(value: string, shape: RegExp, field: string, expected: string): void {
  if (typeof value !== "string" || !shape.test(value)) {
    throw new Error(`buildAttestationReportData: ${field} must be ${expected}`);
  }
}

/**
 * The 64-byte REPORT_DATA/REPORTDATA payload a TEE binds into its attestation report, as 128 lowercase hex
 * chars: `sha256(corpusChecksum:headSha:baseSha) || sha256(runId)`.
 *
 * The first 32 bytes commit to WHICH evaluation ran (#8136) -- the corpus alone would not pin the code
 * revision, and the SHAs alone would not pin the data. The second 32 bytes are the freshness component
 * (#9140): hashing `runId` (rather than embedding it raw) normalizes any caller-chosen hex encoding to a
 * fixed 32-byte width, matching the first half's shape. A verifier recomputes both halves independently and
 * checks the SECOND half's plaintext preimage (`runId`, published in the envelope) against whatever run
 * identifier they expect -- that is what stops a validly-signed but STALE report (same corpus/shas, an old
 * run) from being presented for a different run: a fresh run mints a fresh `runId`, so its `reportData`
 * differs in its entirety even though the corpus/shas half is unchanged.
 *
 * Throws (loudly, rather than silently producing an ambiguous or malformed commitment -- same posture as
 * `canonicalJson` elsewhere in this codebase) when any input is not shaped as documented on
 * {@link AttestationReportDataBinding}.
 *
 * Worked example (test vector, also asserted verbatim in this module's test suite):
 * ```
 * corpusChecksum = "a1".repeat(32) // 64 hex chars
 * headSha        = "b2".repeat(20) // 40 hex chars
 * baseSha        = "c3".repeat(20) // 40 hex chars
 * runId          = "d4".repeat(16) // 32 hex chars
 * reportData =
 *   "3309f8c4eadab7422c8b5ba378a12d52b5676f601faa4dcbac213bae93f5ae7e" +
 *   "1d88ffa7d3cf1f07e5cf64b62016f3e688ad473286f2f613886b6ac02d00541d"
 * ```
 */
export function buildAttestationReportData(binding: AttestationReportDataBinding): string {
  requireShape(binding.corpusChecksum, CORPUS_CHECKSUM_SHAPE, "corpusChecksum", "64 lowercase hex characters");
  requireShape(binding.headSha, GIT_SHA_SHAPE, "headSha", "40 or 64 lowercase hex characters");
  requireShape(binding.baseSha, GIT_SHA_SHAPE, "baseSha", "40 or 64 lowercase hex characters");
  requireShape(binding.runId, RUN_ID_SHAPE, "runId", "1-128 lowercase hex characters");
  const bindingDigest = createHash("sha256").update(`${binding.corpusChecksum}:${binding.headSha}:${binding.baseSha}`).digest("hex");
  const freshnessDigest = createHash("sha256").update(binding.runId).digest("hex");
  return `${bindingDigest}${freshnessDigest}`;
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

  const runId = record["runId"];
  if (
    typeof runId !== "string" ||
    !LOWERCASE_HEX.test(runId) ||
    runId.length < RUN_ID_MIN_HEX ||
    runId.length > RUN_ID_MAX_HEX
  ) {
    errors.push(`runId: expected ${RUN_ID_MIN_HEX}-${RUN_ID_MAX_HEX} lowercase hex characters`);
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
