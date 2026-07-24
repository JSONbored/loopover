import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAttestationReportData, validateAttestationEnvelope, type AttestationEnvelope } from "../dist/index.js";

function validEnvelope(overrides: Partial<Record<keyof AttestationEnvelope, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    teeTechnology: "sev-snp",
    runtimeClass: "confidential-runner-v1",
    measurement: "a".repeat(64),
    reportData: "b".repeat(64),
    attestationReport: "QUJDZA==",
    verification: { status: "unverified" },
    ...overrides,
  };
}

function errorsOf(value: unknown): string[] {
  const result = validateAttestationEnvelope(value);
  assert.equal(result.valid, false);
  return result.valid ? [] : result.errors;
}

test("buildAttestationReportData binds corpusChecksum:headSha:baseSha as lowercase-hex sha256 (pinned vector)", () => {
  assert.equal(
    buildAttestationReportData({ corpusChecksum: "corpus-abc", headSha: "head-111", baseSha: "base-222" }),
    "f3fe846e3d8db839cfa76d48577cad76159f75460d2bf881568ba5d926319e28",
  );
});

test("validateAttestationEnvelope accepts a fully valid envelope", () => {
  const result = validateAttestationEnvelope(validEnvelope());
  assert.equal(result.valid, true);
});

test("validateAttestationEnvelope never throws and rejects non-object inputs", () => {
  for (const bad of [null, undefined, 42, "str", true, []]) {
    const result = validateAttestationEnvelope(bad);
    assert.equal(result.valid, false);
    if (!result.valid) assert.deepEqual(result.errors, ["envelope: must be a non-null object"]);
  }
});

test("validateAttestationEnvelope rejects an unexpected extra key, naming it", () => {
  assert.ok(errorsOf(validEnvelope({ extra: 1 } as never)).includes('envelope: unexpected key "extra"'));
});

test("validateAttestationEnvelope requires schemaVersion literal 1", () => {
  assert.ok(errorsOf(validEnvelope({ schemaVersion: 2 })).includes("schemaVersion: must be the literal 1"));
  assert.ok(errorsOf(validEnvelope({ schemaVersion: "1" })).includes("schemaVersion: must be the literal 1"));
});

test("validateAttestationEnvelope accepts both teeTechnology values, rejects others", () => {
  assert.equal(validateAttestationEnvelope(validEnvelope({ teeTechnology: "tdx" })).valid, true);
  assert.ok(errorsOf(validEnvelope({ teeTechnology: "sgx" })).includes('teeTechnology: must be "sev-snp" or "tdx"'));
});

test("validateAttestationEnvelope enforces runtimeClass (empty/non-string/too-long/boundary)", () => {
  assert.ok(errorsOf(validEnvelope({ runtimeClass: "" })).includes("runtimeClass: must be a non-empty string of at most 128 chars"));
  assert.ok(errorsOf(validEnvelope({ runtimeClass: 5 })).includes("runtimeClass: must be a non-empty string of at most 128 chars"));
  assert.ok(errorsOf(validEnvelope({ runtimeClass: "a".repeat(129) })).includes("runtimeClass: must be a non-empty string of at most 128 chars"));
  assert.equal(validateAttestationEnvelope(validEnvelope({ runtimeClass: "a".repeat(128) })).valid, true);
});

test("validateAttestationEnvelope enforces measurement 32-128 lowercase hex", () => {
  assert.equal(validateAttestationEnvelope(validEnvelope({ measurement: "a".repeat(32) })).valid, true);
  assert.equal(validateAttestationEnvelope(validEnvelope({ measurement: "a".repeat(128) })).valid, true);
  for (const bad of ["a".repeat(31), "a".repeat(129), "A".repeat(64), "g".repeat(64), 123]) {
    assert.ok(errorsOf(validEnvelope({ measurement: bad })).includes("measurement: must be 32-128 lowercase hex chars"));
  }
});

test("validateAttestationEnvelope enforces reportData exactly-64 lowercase hex", () => {
  for (const bad of ["b".repeat(63), "b".repeat(65), "B".repeat(64), 64]) {
    assert.ok(errorsOf(validEnvelope({ reportData: bad })).includes("reportData: must be exactly 64 lowercase hex chars"));
  }
});

test("validateAttestationEnvelope enforces attestationReport base64 (empty/too-long/non-base64/non-string/boundary)", () => {
  for (const bad of ["", "A".repeat(65537), "not base64!", 7]) {
    assert.ok(errorsOf(validEnvelope({ attestationReport: bad })).includes("attestationReport: must be non-empty base64 of at most 65536 chars"));
  }
  assert.equal(validateAttestationEnvelope(validEnvelope({ attestationReport: "A".repeat(65536) })).valid, true);
});

test("validateAttestationEnvelope validates the verification discriminated union", () => {
  assert.ok(errorsOf(validEnvelope({ verification: "unverified" })).includes("verification: must be an object"));
  assert.ok(errorsOf(validEnvelope({ verification: { status: "maybe" } })).includes('verification.status: must be "unverified", "verified", or "failed"'));
  assert.equal(validateAttestationEnvelope(validEnvelope({ verification: { status: "unverified" } })).valid, true);
  assert.equal(validateAttestationEnvelope(validEnvelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "2026-07-24T00:00:00.000Z" } })).valid, true);
  assert.equal(validateAttestationEnvelope(validEnvelope({ verification: { status: "failed", verifierId: "v1", verifiedAt: "2026-07-24T00:00:00+00:00", reason: "mismatch" } })).valid, true);
  assert.ok(errorsOf(validEnvelope({ verification: { status: "verified", verifiedAt: "2026-07-24T00:00:00Z" } })).includes("verification.verifierId: must be a non-empty string"));
  assert.ok(errorsOf(validEnvelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "not-a-date" } })).includes("verification.verifiedAt: must be an ISO-8601 datetime"));
  assert.ok(errorsOf(validEnvelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "2026-13-99T00:00:00Z" } })).includes("verification.verifiedAt: must be an ISO-8601 datetime"));
  assert.ok(errorsOf(validEnvelope({ verification: { status: "failed", verifierId: "v1", verifiedAt: "2026-07-24T00:00:00Z" } })).includes("verification.reason: must be a non-empty string"));
});
