import { describe, expect, it } from "vitest";
// Direct src-path import (not the `@loopover/engine` barrel, which resolves to dist and is NOT in vitest's
// coverage.include): the engine's node:test suite runs against dist and is invisible to Codecov, so this
// vitest mirror is what gives packages/loopover-engine/src/calibration/attestation-envelope.ts its
// codecov/patch coverage (the "engine blind-spot rule", same as #8438 did for signal-tracking.ts). The
// companion packages/loopover-engine/test/attestation-envelope.test.ts is the node:test that gates the engine
// workspace's own `npm run test`.
import { buildAttestationReportData, validateAttestationEnvelope } from "../../packages/loopover-engine/src/calibration/attestation-envelope.js";
import type { AttestationEnvelope } from "../../packages/loopover-engine/src/calibration/attestation-envelope.js";

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

function firstErrors(value: unknown): string[] {
  const result = validateAttestationEnvelope(value);
  expect(result.valid).toBe(false);
  return result.valid ? [] : result.errors;
}

describe("buildAttestationReportData (#8541)", () => {
  it("binds corpusChecksum:headSha:baseSha as lowercase-hex sha256 (pinned vector)", () => {
    expect(buildAttestationReportData({ corpusChecksum: "corpus-abc", headSha: "head-111", baseSha: "base-222" })).toBe(
      "f3fe846e3d8db839cfa76d48577cad76159f75460d2bf881568ba5d926319e28",
    );
  });

  it("is deterministic and produces a 64-char lowercase hex string", () => {
    const out = buildAttestationReportData({ corpusChecksum: "x", headSha: "y", baseSha: "z" });
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(buildAttestationReportData({ corpusChecksum: "x", headSha: "y", baseSha: "z" })).toBe(out);
  });
});

describe("validateAttestationEnvelope (#8541)", () => {
  it("accepts a fully valid envelope and narrows it", () => {
    const result = validateAttestationEnvelope(validEnvelope());
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.envelope.schemaVersion).toBe(1);
  });

  it("never throws and rejects non-object inputs (null, primitives, arrays)", () => {
    for (const bad of [null, undefined, 42, "str", true, []]) {
      const result = validateAttestationEnvelope(bad);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors).toEqual(["envelope: must be a non-null object"]);
    }
  });

  it("rejects an unexpected extra key, naming it", () => {
    expect(firstErrors(validEnvelope({ extra: 1 } as never))).toContain('envelope: unexpected key "extra"');
  });

  it("requires schemaVersion to be the literal 1", () => {
    expect(firstErrors(validEnvelope({ schemaVersion: 2 }))).toContain("schemaVersion: must be the literal 1");
    expect(firstErrors(validEnvelope({ schemaVersion: "1" }))).toContain("schemaVersion: must be the literal 1");
  });

  it("accepts both teeTechnology values and rejects any other", () => {
    expect(validateAttestationEnvelope(validEnvelope({ teeTechnology: "tdx" })).valid).toBe(true);
    expect(firstErrors(validEnvelope({ teeTechnology: "sgx" }))).toContain('teeTechnology: must be "sev-snp" or "tdx"');
  });

  it("requires a non-empty runtimeClass of at most 128 chars", () => {
    expect(firstErrors(validEnvelope({ runtimeClass: "" }))).toContain("runtimeClass: must be a non-empty string of at most 128 chars");
    expect(firstErrors(validEnvelope({ runtimeClass: 5 }))).toContain("runtimeClass: must be a non-empty string of at most 128 chars");
    expect(firstErrors(validEnvelope({ runtimeClass: "a".repeat(129) }))).toContain("runtimeClass: must be a non-empty string of at most 128 chars");
    expect(validateAttestationEnvelope(validEnvelope({ runtimeClass: "a".repeat(128) })).valid).toBe(true);
  });

  it("requires measurement to be 32-128 lowercase hex chars (boundaries + non-hex + non-string)", () => {
    expect(validateAttestationEnvelope(validEnvelope({ measurement: "a".repeat(32) })).valid).toBe(true);
    expect(validateAttestationEnvelope(validEnvelope({ measurement: "a".repeat(128) })).valid).toBe(true);
    expect(firstErrors(validEnvelope({ measurement: "a".repeat(31) }))).toContain("measurement: must be 32-128 lowercase hex chars");
    expect(firstErrors(validEnvelope({ measurement: "a".repeat(129) }))).toContain("measurement: must be 32-128 lowercase hex chars");
    expect(firstErrors(validEnvelope({ measurement: "A".repeat(64) }))).toContain("measurement: must be 32-128 lowercase hex chars");
    expect(firstErrors(validEnvelope({ measurement: "g".repeat(64) }))).toContain("measurement: must be 32-128 lowercase hex chars");
    expect(firstErrors(validEnvelope({ measurement: 123 }))).toContain("measurement: must be 32-128 lowercase hex chars");
  });

  it("requires reportData to be exactly 64 lowercase hex chars (63/65 + non-hex + non-string)", () => {
    expect(firstErrors(validEnvelope({ reportData: "b".repeat(63) }))).toContain("reportData: must be exactly 64 lowercase hex chars");
    expect(firstErrors(validEnvelope({ reportData: "b".repeat(65) }))).toContain("reportData: must be exactly 64 lowercase hex chars");
    expect(firstErrors(validEnvelope({ reportData: "B".repeat(64) }))).toContain("reportData: must be exactly 64 lowercase hex chars");
    expect(firstErrors(validEnvelope({ reportData: 64 }))).toContain("reportData: must be exactly 64 lowercase hex chars");
  });

  it("requires attestationReport to be non-empty base64 of at most 65536 chars (empty/too-long/non-base64/non-string)", () => {
    expect(firstErrors(validEnvelope({ attestationReport: "" }))).toContain("attestationReport: must be non-empty base64 of at most 65536 chars");
    expect(firstErrors(validEnvelope({ attestationReport: "A".repeat(65537) }))).toContain("attestationReport: must be non-empty base64 of at most 65536 chars");
    expect(firstErrors(validEnvelope({ attestationReport: "not base64!" }))).toContain("attestationReport: must be non-empty base64 of at most 65536 chars");
    expect(firstErrors(validEnvelope({ attestationReport: 7 }))).toContain("attestationReport: must be non-empty base64 of at most 65536 chars");
    expect(validateAttestationEnvelope(validEnvelope({ attestationReport: "A".repeat(65536) })).valid).toBe(true);
  });

  it("validates the verification discriminated union — unverified/verified/failed and their members", () => {
    // Non-object and unknown status.
    expect(firstErrors(validEnvelope({ verification: "unverified" }))).toContain("verification: must be an object");
    expect(firstErrors(validEnvelope({ verification: { status: "maybe" } }))).toContain('verification.status: must be "unverified", "verified", or "failed"');
    // Valid variants.
    expect(validateAttestationEnvelope(validEnvelope({ verification: { status: "unverified" } })).valid).toBe(true);
    expect(validateAttestationEnvelope(validEnvelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "2026-07-24T00:00:00.000Z" } })).valid).toBe(true);
    expect(validateAttestationEnvelope(validEnvelope({ verification: { status: "failed", verifierId: "v1", verifiedAt: "2026-07-24T00:00:00+00:00", reason: "measurement mismatch" } })).valid).toBe(true);
    // Missing / invalid members.
    expect(firstErrors(validEnvelope({ verification: { status: "verified", verifiedAt: "2026-07-24T00:00:00Z" } }))).toContain("verification.verifierId: must be a non-empty string");
    expect(firstErrors(validEnvelope({ verification: { status: "verified", verifierId: 9, verifiedAt: "2026-07-24T00:00:00Z" } }))).toContain("verification.verifierId: must be a non-empty string");
    expect(firstErrors(validEnvelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "not-a-date" } }))).toContain("verification.verifiedAt: must be an ISO-8601 datetime");
    // Well-shaped but impossible datetime (regex matches, Date.parse is NaN).
    expect(firstErrors(validEnvelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "2026-13-99T00:00:00Z" } }))).toContain("verification.verifiedAt: must be an ISO-8601 datetime");
    expect(firstErrors(validEnvelope({ verification: { status: "failed", verifierId: "v1", verifiedAt: "2026-07-24T00:00:00Z" } }))).toContain("verification.reason: must be a non-empty string");
  });

  it("accumulates every failing field path in one pass", () => {
    const errors = firstErrors({ schemaVersion: 2, teeTechnology: "sgx", runtimeClass: "", measurement: "z", reportData: "z", attestationReport: "", verification: { status: "nope" } });
    expect(errors.length).toBeGreaterThanOrEqual(7);
  });
});
