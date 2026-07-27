import { describe, expect, it } from "vitest";

// Direct src-path import (not the `@loopover/engine` barrel, which resolves to dist and is NOT in vitest's
// coverage.include): the engine's own node:test suite runs against dist and is invisible to Codecov, so this
// vitest mirror is what gives the module its codecov/patch coverage -- same seam as
// attestation-envelope-engine.test.ts. The companion packages/loopover-engine/test/attester.test.ts gates the
// engine workspace's own `npm run test` against the built barrel.
import {
  SAMPLE_ATTESTATION_MAGIC,
  assembleAttestationEnvelope,
  createSampleAttester,
  isSampleAttestationReport,
  type Attester,
} from "../../packages/loopover-engine/src/calibration/attester.js";
import { buildAttestationReportData } from "../../packages/loopover-engine/src/calibration/attestation-envelope.js";

const CORPUS_CHECKSUM = "a1".repeat(32); // 64 hex
const HEAD_SHA = "b2".repeat(20); // 40 hex
const BASE_SHA = "c3".repeat(20); // 40 hex
const RUN_ID = "d4".repeat(16); // 32 hex
const BINDING = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
const RUNTIME_CLASS = "loopover-backtest-runner";

/** An attester that returns exactly what a test dictates -- the seam's whole point is that a runner can't
 *  tell implementations apart, so the tests exercise it the same way a runner would. */
function fakeAttester(collection: Record<string, unknown>, kind = "fake"): Attester {
  return { kind, collect: () => Promise.resolve(collection as never) };
}

describe("createSampleAttester", () => {
  it("defaults to sev-snp and derives every field deterministically from the request", async () => {
    const attester = createSampleAttester();
    expect(attester.kind).toBe("sample");

    const request = { reportData: "b".repeat(128), runtimeClass: RUNTIME_CLASS };
    const first = await attester.collect(request);
    const second = await attester.collect(request);

    expect(first.teeTechnology).toBe("sev-snp");
    expect(first).toEqual(second); // deterministic: same request, byte-identical collection
    expect(first.measurement).toMatch(/^[0-9a-f]{64}$/);
    expect(isSampleAttestationReport(first.attestationReport)).toBe(true);
  });

  it("honors an explicit teeTechnology (the ?? fallback's other arm)", async () => {
    const attester = createSampleAttester({ teeTechnology: "tdx" });
    const collection = await attester.collect({ reportData: "b".repeat(128), runtimeClass: RUNTIME_CLASS });
    expect(collection.teeTechnology).toBe("tdx");
  });

  it("binds the report to the request: a different reportData yields a different report", async () => {
    const attester = createSampleAttester();
    const a = await attester.collect({ reportData: "b".repeat(128), runtimeClass: RUNTIME_CLASS });
    const b = await attester.collect({ reportData: "c".repeat(128), runtimeClass: RUNTIME_CLASS });
    expect(a.attestationReport).not.toBe(b.attestationReport);
    // ...while the measurement tracks the runtime class alone, not the payload.
    expect(a.measurement).toBe(b.measurement);
  });
});

describe("isSampleAttestationReport", () => {
  it("detects a sample report by its magic prefix", () => {
    const report = Buffer.from(`${SAMPLE_ATTESTATION_MAGIC}:abc`, "utf8").toString("base64");
    expect(isSampleAttestationReport(report)).toBe(true);
  });

  it("returns false for base64 that decodes to something else", () => {
    expect(isSampleAttestationReport(Buffer.from("a real report", "utf8").toString("base64"))).toBe(false);
  });

  it("returns false -- never throws -- for a non-string, and for an empty string", () => {
    expect(isSampleAttestationReport(undefined)).toBe(false);
    expect(isSampleAttestationReport(null)).toBe(false);
    expect(isSampleAttestationReport(42)).toBe(false);
    expect(isSampleAttestationReport("")).toBe(false);
  });
});

describe("assembleAttestationEnvelope", () => {
  it("assembles a valid, unverified envelope and computes reportData from the binding itself", async () => {
    const result = await assembleAttestationEnvelope(createSampleAttester(), BINDING, RUNTIME_CLASS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.envelope.reportData).toBe(buildAttestationReportData(BINDING));
    expect(result.envelope.runId).toBe(RUN_ID);
    expect(result.envelope.runtimeClass).toBe(RUNTIME_CLASS);
    expect(result.envelope.schemaVersion).toBe(1);
    // Assembly never self-certifies -- promoting this is the verifier's job (#9212).
    expect(result.envelope.verification).toEqual({ status: "unverified" });
  });

  it("ignores any reportData an attester tries to restate: the binding is the only source", async () => {
    // The fake echoes a bogus reportData in its collection; assembly must not read it back.
    const attester = fakeAttester({
      teeTechnology: "sev-snp",
      measurement: "a".repeat(64),
      reportData: "f".repeat(128),
      attestationReport: "QUJD",
    });
    const result = await assembleAttestationEnvelope(attester, BINDING, RUNTIME_CLASS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.reportData).toBe(buildAttestationReportData(BINDING));
  });

  it("returns ok:false with the validator's errors when a collection is structurally invalid", async () => {
    const attester = fakeAttester({
      teeTechnology: "sev-snp",
      measurement: "not-hex",
      attestationReport: "QUJD",
    });
    const result = await assembleAttestationEnvelope(attester, BINDING, RUNTIME_CLASS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.startsWith("measurement:"))).toBe(true);
  });

  it("converts a throwing attester into ok:false, naming the attester kind (Error arm)", async () => {
    const attester: Attester = {
      kind: "sev-snp",
      collect: () => Promise.reject(new Error("/dev/sev-guest not present")),
    };
    const result = await assembleAttestationEnvelope(attester, BINDING, RUNTIME_CLASS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["attester(sev-snp): collection failed: /dev/sev-guest not present"]);
  });

  it("converts a non-Error throw into ok:false too (the instanceof fallback arm)", async () => {
    const attester: Attester = { kind: "flaky", collect: () => Promise.reject("agent timeout") };
    const result = await assembleAttestationEnvelope(attester, BINDING, RUNTIME_CLASS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["attester(flaky): collection failed: agent timeout"]);
  });

  it("throws on a malformed binding -- a caller-side programmer error, per buildAttestationReportData", async () => {
    await expect(
      assembleAttestationEnvelope(createSampleAttester(), { ...BINDING, headSha: "nope" }, RUNTIME_CLASS),
    ).rejects.toThrow(/headSha must be 40 or 64 lowercase hex characters/);
  });

  it("a sample-attested envelope stays identifiable as a dev artifact after assembly", async () => {
    const result = await assembleAttestationEnvelope(createSampleAttester(), BINDING, RUNTIME_CLASS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isSampleAttestationReport(result.envelope.attestationReport)).toBe(true);
  });
});
