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
} from "../../packages/loopover-engine/src/calibration/attestation-envelope.js";

const MEASUREMENT = "a".repeat(64);
const REPORT_DATA = "b".repeat(64);

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    teeTechnology: "sev-snp",
    runtimeClass: "loopover-backtest-runner",
    measurement: MEASUREMENT,
    reportData: REPORT_DATA,
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

describe("buildAttestationReportData (#8541)", () => {
  it("is the lowercase-hex sha256 of corpusChecksum:headSha:baseSha (pinned vector)", () => {
    // Precomputed: sha256("abc123:head456:base789"). Pinned so a change to the binding format -- which would
    // silently invalidate every previously-attested run -- fails here instead of shipping.
    expect(buildAttestationReportData({ corpusChecksum: "abc123", headSha: "head456", baseSha: "base789" })).toBe(
      "fcc875115df49bf143b18fc8a8071e9a946858407fabf61e59ef1607d1cfb140",
    );
  });

  it("produces exactly 64 lowercase hex chars and is deterministic and field-order sensitive", () => {
    const data = buildAttestationReportData({ corpusChecksum: "c", headSha: "h", baseSha: "b" });
    expect(data).toMatch(/^[0-9a-f]{64}$/);
    expect(data).toBe(buildAttestationReportData({ corpusChecksum: "c", headSha: "h", baseSha: "b" }));
    // Swapping which value lands in which position must change the digest (the fields are not interchangeable).
    expect(data).not.toBe(buildAttestationReportData({ corpusChecksum: "h", headSha: "c", baseSha: "b" }));
  });

  it("emits output usable as an envelope's reportData", () => {
    const reportData = buildAttestationReportData({ corpusChecksum: "c", headSha: "h", baseSha: "b" });
    expect(validateAttestationEnvelope(envelope({ reportData })).valid).toBe(true);
  });
});

describe("validateAttestationEnvelope (#8541)", () => {
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

  it("requires reportData to be exactly 64 lowercase hex (63 and 65 both rejected)", () => {
    expect(validateAttestationEnvelope(envelope({ reportData: "b".repeat(64) })).valid).toBe(true);
    expectRejected(envelope({ reportData: "b".repeat(63) }), "reportData");
    expectRejected(envelope({ reportData: "b".repeat(65) }), "reportData");
    expectRejected(envelope({ reportData: "B".repeat(64) }), "reportData"); // uppercase
    expectRejected(envelope({ reportData: "z".repeat(64) }), "reportData"); // non-hex
    expectRejected(envelope({ reportData: null }), "reportData");
  });

  it("requires attestationReport to be non-empty base64 within the size cap", () => {
    expect(validateAttestationEnvelope(envelope({ attestationReport: "QUJD" })).valid).toBe(true);
    expect(validateAttestationEnvelope(envelope({ attestationReport: "QQ==" })).valid).toBe(true);
    expect(validateAttestationEnvelope(envelope({ attestationReport: "A".repeat(65536) })).valid).toBe(true);
    expectRejected(envelope({ attestationReport: "A".repeat(65537) }), "attestationReport");
    expectRejected(envelope({ attestationReport: "" }), "attestationReport");
    expectRejected(envelope({ attestationReport: "not base64!" }), "attestationReport");
    expectRejected(envelope({ attestationReport: 1 }), "attestationReport");
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
      { schemaVersion: 2, teeTechnology: "sgx", runtimeClass: "", measurement: "zz", reportData: "b", attestationReport: "", verification: null },
      "schemaVersion",
    );
    for (const field of ["teeTechnology", "runtimeClass", "measurement", "reportData", "attestationReport", "verification"]) {
      expect(errors.some((error) => error.startsWith(field))).toBe(true);
    }
  });
});
