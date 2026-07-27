import { describe, expect, it } from "vitest";

// Direct src-path import (not the `@loopover/engine` barrel, which resolves to dist and is NOT in vitest's
// coverage.include): the engine's own node:test suite runs against dist and is invisible to Codecov, so this
// vitest mirror is what gives the module its codecov/patch coverage -- the same seam #8438 used for
// signal-tracking.ts. The companion packages/loopover-engine/test/attestation-envelope.test.ts gates the
// engine workspace's own `npm run test` against the built barrel.
import {
  buildAttestationReportData,
  validateAttestationEnvelope,
  type AttestationEnvelope,
} from "../../packages/loopover-engine/src/calibration/attestation-envelope";

const MEASUREMENT = "a".repeat(64);
// #9140: reportData is now 128 hex chars (64 bytes -- SEV-SNP/TDX's REPORT_DATA/REPORTDATA field width),
// with a `runId` freshness field alongside it -- see this module's own doc comment for the finalized layout.
const REPORT_DATA = "b".repeat(128);
const RUN_ID = "d4".repeat(16);
const CORPUS_CHECKSUM = "a1".repeat(32); // 64 hex
const HEAD_SHA = "b2".repeat(20); // 40 hex
const BASE_SHA = "c3".repeat(20); // 40 hex

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    teeTechnology: "sev-snp",
    runtimeClass: "loopover-backtest-runner",
    measurement: MEASUREMENT,
    reportData: REPORT_DATA,
    runId: RUN_ID,
    attestationReport: "QUJD",
    verification: { status: "unverified" },
    ...overrides,
  };
}

/** Assert rejection AND that the error names the failing field path (the contract callers log). */
function expectRejected(value: unknown, fieldPath: string): string[] {
  const result = validateAttestationEnvelope(value);
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("expected invalid");
  expect(result.errors.some((error) => error.startsWith(fieldPath))).toBe(true);
  return result.errors;
}

describe("buildAttestationReportData (#8541, #9140)", () => {
  it("is sha256(corpusChecksum:headSha:baseSha) || sha256(runId), 128 lowercase hex chars (pinned vector)", () => {
    // Precomputed. Pinned so a change to the binding/layout -- which would silently invalidate every
    // previously-attested run -- fails here instead of shipping. Also published verbatim in
    // buildAttestationReportData's own doc comment as the spec a non-JS verifier reimplements against.
    expect(buildAttestationReportData({ corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID })).toBe(
      "3309f8c4eadab7422c8b5ba378a12d52b5676f601faa4dcbac213bae93f5ae7e" +
        "1d88ffa7d3cf1f07e5cf64b62016f3e688ad473286f2f613886b6ac02d00541d",
    );
  });

  it("produces exactly 128 lowercase hex chars and is deterministic and field-order sensitive", () => {
    const base = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
    const data = buildAttestationReportData(base);
    expect(data).toMatch(/^[0-9a-f]{128}$/);
    expect(data).toBe(buildAttestationReportData(base));
    // Swapping which value lands in which position must change the digest (the fields are not interchangeable).
    expect(data).not.toBe(buildAttestationReportData({ ...base, headSha: BASE_SHA, baseSha: HEAD_SHA }));
  });

  it("is injective over the (corpusChecksum, headSha, baseSha, runId) quadruple", () => {
    const base = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
    const variants = [
      base,
      { ...base, corpusChecksum: "a2".repeat(32) },
      { ...base, headSha: "b3".repeat(20) },
      { ...base, baseSha: "c4".repeat(20) },
      { ...base, runId: "d5".repeat(16) },
      { ...base, headSha: "b2".repeat(32) }, // a different valid width (64-hex SHA-256 git object id)
    ];
    const digests = variants.map((binding) => buildAttestationReportData(binding));
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("only the second 64 hex chars move when runId changes; only the first 64 move for a binding-only change", () => {
    const base = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
    const baseReportData = buildAttestationReportData(base);
    const freshRun = buildAttestationReportData({ ...base, runId: "d5".repeat(16) });
    expect(freshRun.slice(0, 64)).toBe(baseReportData.slice(0, 64));
    expect(freshRun.slice(64)).not.toBe(baseReportData.slice(64));

    const rebound = buildAttestationReportData({ ...base, corpusChecksum: "a2".repeat(32) });
    expect(rebound.slice(0, 64)).not.toBe(baseReportData.slice(0, 64));
    expect(rebound.slice(64)).toBe(baseReportData.slice(64));
  });

  it("throws on a malformed input shape instead of silently mis-committing", () => {
    const base = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
    // A colon injected into corpusChecksum can never pass the hex-shape check, closing the ambiguity gap.
    expect(() => buildAttestationReportData({ ...base, corpusChecksum: `${CORPUS_CHECKSUM.slice(0, 63)}:` })).toThrow(/corpusChecksum/);
    expect(() => buildAttestationReportData({ ...base, corpusChecksum: "abc123" })).toThrow(/corpusChecksum/);
    expect(() => buildAttestationReportData({ ...base, headSha: "not-hex-and-wrong-length" })).toThrow(/headSha/);
    expect(() => buildAttestationReportData({ ...base, baseSha: "" })).toThrow(/baseSha/);
    expect(() => buildAttestationReportData({ ...base, runId: "UPPER" })).toThrow(/runId/);
    expect(() => buildAttestationReportData({ ...base, runId: "" })).toThrow(/runId/);
  });

  it("emits output usable as an envelope's reportData", () => {
    const reportData = buildAttestationReportData({ corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID });
    expect(validateAttestationEnvelope(envelope({ reportData, runId: RUN_ID })).valid).toBe(true);
  });
});

describe("validateAttestationEnvelope (#8541, #9140)", () => {
  it("accepts a well-formed envelope and returns it narrowed", () => {
    const result = validateAttestationEnvelope(envelope());
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.errors.join("; "));
    const narrowed: AttestationEnvelope = result.envelope;
    expect(narrowed.schemaVersion).toBe(1);
    expect(narrowed.verification.status).toBe("unverified");
  });

  it("never throws for non-object input, returning a single envelope-level error", () => {
    for (const value of [null, undefined, 0, 1, "", "envelope", true, false, [], [envelope()], Symbol("x"), 9n]) {
      const result = validateAttestationEnvelope(value);
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error("expected invalid");
      expect(result.errors).toEqual(["envelope: expected an object"]);
    }
  });

  it("rejects an unexpected top-level key by name", () => {
    const errors = expectRejected(envelope({ rogue: 1 }), "rogue");
    expect(errors.some((error) => error.includes("unexpected key"))).toBe(true);
  });

  it("requires the literal schemaVersion 1 (both arms)", () => {
    expect(validateAttestationEnvelope(envelope({ schemaVersion: 1 })).valid).toBe(true);
    for (const bad of [0, 2, "1", null, undefined]) expectRejected(envelope({ schemaVersion: bad }), "schemaVersion");
  });

  it("accepts each supported teeTechnology and rejects anything else", () => {
    for (const good of ["sev-snp", "tdx"]) expect(validateAttestationEnvelope(envelope({ teeTechnology: good })).valid).toBe(true);
    for (const bad of ["SEV-SNP", "sgx", "", 1, null]) expectRejected(envelope({ teeTechnology: bad }), "teeTechnology");
  });

  it("bounds runtimeClass at 1..128 characters (accepts the boundary, rejects just past it)", () => {
    expect(validateAttestationEnvelope(envelope({ runtimeClass: "x" })).valid).toBe(true);
    expect(validateAttestationEnvelope(envelope({ runtimeClass: "x".repeat(128) })).valid).toBe(true);
    expectRejected(envelope({ runtimeClass: "x".repeat(129) }), "runtimeClass");
    for (const bad of ["", 1, null, undefined]) expectRejected(envelope({ runtimeClass: bad }), "runtimeClass");
  });

  it("requires measurement to be 32..128 lowercase hex (boundaries accepted, just-past rejected)", () => {
    expect(validateAttestationEnvelope(envelope({ measurement: "a".repeat(32) })).valid).toBe(true);
    expect(validateAttestationEnvelope(envelope({ measurement: "a".repeat(128) })).valid).toBe(true);
    expectRejected(envelope({ measurement: "a".repeat(31) }), "measurement");
    expectRejected(envelope({ measurement: "a".repeat(129) }), "measurement");
    expectRejected(envelope({ measurement: "A".repeat(64) }), "measurement"); // uppercase hex
    expectRejected(envelope({ measurement: "g".repeat(64) }), "measurement"); // non-hex
    expectRejected(envelope({ measurement: 64 }), "measurement");
  });

  it("requires reportData to be exactly 128 lowercase hex (127 and 129 both rejected)", () => {
    expect(validateAttestationEnvelope(envelope({ reportData: "b".repeat(128) })).valid).toBe(true);
    expectRejected(envelope({ reportData: "b".repeat(127) }), "reportData");
    expectRejected(envelope({ reportData: "b".repeat(129) }), "reportData");
    expectRejected(envelope({ reportData: "b".repeat(64) }), "reportData"); // #9140: the pre-fix (32-byte) width
    expectRejected(envelope({ reportData: "B".repeat(128) }), "reportData"); // uppercase
    expectRejected(envelope({ reportData: "z".repeat(128) }), "reportData"); // non-hex
    expectRejected(envelope({ reportData: null }), "reportData");
  });

  it("#9140: requires runId to be 1..128 lowercase hex", () => {
    expect(validateAttestationEnvelope(envelope({ runId: "a" })).valid).toBe(true);
    expect(validateAttestationEnvelope(envelope({ runId: "a".repeat(128) })).valid).toBe(true);
    expectRejected(envelope({ runId: "a".repeat(129) }), "runId");
    expectRejected(envelope({ runId: "" }), "runId");
    expectRejected(envelope({ runId: "NOTHEX" }), "runId");
    expectRejected(envelope({ runId: undefined }), "runId");
    expectRejected(envelope({ runId: 1 }), "runId");
  });

  it("requires attestationReport to be non-empty, length-valid base64 within the size cap", () => {
    expect(validateAttestationEnvelope(envelope({ attestationReport: "QUJD" })).valid).toBe(true);
    expect(validateAttestationEnvelope(envelope({ attestationReport: "QQ==" })).valid).toBe(true);
    expect(validateAttestationEnvelope(envelope({ attestationReport: "A".repeat(65536) })).valid).toBe(true);
    expectRejected(envelope({ attestationReport: "A".repeat(65537) }), "attestationReport");
    expectRejected(envelope({ attestationReport: "" }), "attestationReport");
    expectRejected(envelope({ attestationReport: "not base64!" }), "attestationReport");
    expectRejected(envelope({ attestationReport: 1 }), "attestationReport");
    // #9140: a run of valid base64-alphabet characters whose length is NOT a multiple of 4 is not valid
    // base64 under any padding rule -- the old regex accepted it anyway.
    expectRejected(envelope({ attestationReport: "QUJDQ" }), "attestationReport"); // 5 chars
    expectRejected(envelope({ attestationReport: "QUJDQQ" }), "attestationReport"); // 6 chars, unpadded
    expect(validateAttestationEnvelope(envelope({ attestationReport: "QUJDQQ==" })).valid).toBe(true); // properly padded
  });

  describe("verification union", () => {
    const VERIFIED_AT = "2026-07-25T00:00:00.000Z";

    it("accepts every valid variant", () => {
      expect(validateAttestationEnvelope(envelope({ verification: { status: "unverified" } })).valid).toBe(true);
      expect(
        validateAttestationEnvelope(envelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: VERIFIED_AT } })).valid,
      ).toBe(true);
      expect(
        validateAttestationEnvelope(
          envelope({ verification: { status: "failed", verifierId: "v1", verifiedAt: VERIFIED_AT, reason: "signature mismatch" } }),
        ).valid,
      ).toBe(true);
    });

    it("rejects a non-object or unknown status", () => {
      for (const bad of [null, "unverified", 1, []]) expectRejected(envelope({ verification: bad }), "verification");
      expectRejected(envelope({ verification: { status: "pending" } }), "verification.status");
    });

    it("rejects a missing or invalid member of the verified variant", () => {
      expectRejected(envelope({ verification: { status: "verified", verifiedAt: VERIFIED_AT } }), "verification.verifierId");
      expectRejected(envelope({ verification: { status: "verified", verifierId: "", verifiedAt: VERIFIED_AT } }), "verification.verifierId");
      expectRejected(envelope({ verification: { status: "verified", verifierId: "v1" } }), "verification.verifiedAt");
      expectRejected(envelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "not-a-date" } }), "verification.verifiedAt");
      // Date.parse alone tolerates this; the shape check is what rejects it.
      expectRejected(envelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "2026-07-25" } }), "verification.verifiedAt");
      // Matches the ISO shape but is not a real instant -- covers the Date.parse operand specifically.
      expectRejected(envelope({ verification: { status: "verified", verifierId: "v1", verifiedAt: "2026-13-45T99:99:99Z" } }), "verification.verifiedAt");
    });

    it("rejects a missing or empty reason on the failed variant, and extra keys on any variant", () => {
      expectRejected(envelope({ verification: { status: "failed", verifierId: "v1", verifiedAt: VERIFIED_AT } }), "verification.reason");
      expectRejected(
        envelope({ verification: { status: "failed", verifierId: "v1", verifiedAt: VERIFIED_AT, reason: "" } }),
        "verification.reason",
      );
      // unverified carries no other members -- an extra key is named, not ignored.
      expectRejected(envelope({ verification: { status: "unverified", verifierId: "v1" } }), "verification.verifierId");
    });
  });

  it("reports every failing field at once rather than stopping at the first", () => {
    const errors = expectRejected(
      { schemaVersion: 2, teeTechnology: "sgx", runtimeClass: "", measurement: "zz", reportData: "b", runId: "", attestationReport: "", verification: null },
      "schemaVersion",
    );
    for (const field of ["teeTechnology", "runtimeClass", "measurement", "reportData", "runId", "attestationReport", "verification"]) {
      expect(errors.some((error) => error.startsWith(field))).toBe(true);
    }
  });
});
