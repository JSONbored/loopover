import { readFileSync } from "node:fs";
import { sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildAttestationReportData } from "../../packages/loopover-engine/src/calibration/attestation-envelope";
import { formatCaughtError, readVcekTcbFromCertificate, verifyAttestedRun, type VerifyAttestedRunInput } from "../../scripts/verify-attested-run-core";
import { SNP_REPORT_SIZE } from "../../scripts/verify-attested-run-report";

// A real, freshly-generated (openssl) 3-tier PKI mirroring AMD's exact hierarchy shape -- RSA-4096-PSS-SHA384
// root (self-signed) -> RSA-4096-PSS-SHA384 intermediate (root-signed) -> EC-P384 leaf carrying the real AMD
// KDS SVN OIDs (root-of-trust-signed via the intermediate). This is SYNTHETIC: it is not, and cannot be,
// signed by AMD's real private keys (nobody outside AMD holds those). It exists to exercise every real
// cryptographic operation this module performs -- chain verification, ECDSA-P384-SHA384 report-signature
// verification, OID-based TCB extraction -- against genuine, independently-generated key material, never a
// mock that returns a canned `true`. The real, vendored AMD Milan/Genoa ARK/ASK roots live alongside this
// fixture set and are what the CLI actually ships and pins in production.
const FIXTURES = "test/fixtures/verify-attested-run";
const vcekKeyPem = readFileSync(`${FIXTURES}/synthetic-vcek-key.pem`, "utf8");
const vcekCertPem = readFileSync(`${FIXTURES}/synthetic-vcek-cert.pem`, "utf8");
const askCertPem = readFileSync(`${FIXTURES}/synthetic-intermediate-cert.pem`, "utf8");
const arkCertPem = readFileSync(`${FIXTURES}/synthetic-root-cert.pem`, "utf8");

const CORPUS_CHECKSUM = "a1".repeat(32);
const HEAD_SHA = "b2".repeat(20);
const BASE_SHA = "c3".repeat(20);
const RUN_ID = "d4".repeat(16);
const REPORT_DATA_HEX = buildAttestationReportData({ corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID });
const MEASUREMENT_HEX = "ee".repeat(48);
const TEST_TCB = [3, 5, 0, 0, 0, 0, 9, 200] as const; // matches the SVN values baked into the synthetic VCEK cert's OIDs

function toAmdEcdsaField(bigEndian48: Buffer): Buffer {
  return Buffer.from(Buffer.concat([Buffer.alloc(24), bigEndian48])).reverse();
}

/** Build a real, genuinely-signed (against the synthetic VCEK's real private key) 1184-byte SNP report. */
function buildSignedReport(overrides: { tcb?: readonly number[]; measurementHex?: string; reportDataHex?: string } = {}): Buffer {
  const report = Buffer.alloc(SNP_REPORT_SIZE);
  report.writeUInt32LE(2, 0x00);
  report.writeUInt32LE(1, 0x34);
  const tcb = Buffer.from(overrides.tcb ?? TEST_TCB);
  tcb.copy(report, 0x38);
  tcb.copy(report, 0x180);
  Buffer.from(overrides.reportDataHex ?? REPORT_DATA_HEX, "hex").copy(report, 0x50);
  Buffer.from(overrides.measurementHex ?? MEASUREMENT_HEX, "hex").copy(report, 0x90);
  Buffer.alloc(64, 0x11).copy(report, 0x1a0);

  const signedBytes = report.subarray(0, 0x2a0);
  const p1363Sig = sign("sha384", signedBytes, { key: vcekKeyPem, dsaEncoding: "ieee-p1363" });
  const sigStruct = Buffer.alloc(0x200);
  toAmdEcdsaField(p1363Sig.subarray(0, 48)).copy(sigStruct, 0);
  toAmdEcdsaField(p1363Sig.subarray(48, 96)).copy(sigStruct, 72);
  sigStruct.copy(report, 0x2a0);
  return report;
}

function baseInput(overrides: Partial<VerifyAttestedRunInput> = {}): VerifyAttestedRunInput {
  const rawReportBytes = buildSignedReport();
  return {
    envelope: {
      schemaVersion: 1,
      teeTechnology: "sev-snp",
      runtimeClass: "loopover-backtest-runner",
      measurement: MEASUREMENT_HEX,
      reportData: REPORT_DATA_HEX,
      runId: RUN_ID,
      attestationReport: Buffer.from(rawReportBytes).toString("base64"),
      verification: { status: "unverified" },
    },
    rawReportBytes,
    vcekCertPem,
    askCertPem,
    arkCertPem,
    pinnedArkCertPem: arkCertPem,
    expectedMeasurementHex: MEASUREMENT_HEX,
    corpusChecksum: CORPUS_CHECKSUM,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    allowSample: false,
    ...overrides,
  };
}

describe("verifyAttestedRun (real synthetic PKI, real ECDSA-P384-SHA384 signatures)", () => {
  it("verifies a genuinely well-formed, correctly-signed, correctly-chained attested run", () => {
    expect(verifyAttestedRun(baseInput())).toEqual({ verified: true });
  });

  it("rejects a sample-attester envelope by default", () => {
    const input = baseInput();
    input.envelope = { ...input.envelope, attestationReport: Buffer.from("LOOPOVER-SAMPLE-ATTESTATION-v1:x").toString("base64") };
    const result = verifyAttestedRun(input);
    expect(result).toEqual({ verified: false, failureClass: "sample_attestation", reason: expect.stringContaining("--allow-sample") });
  });

  it("accepts a sample-attester envelope when allowSample is true, for the rest of the checks to then run against it", () => {
    // The sample marker is set on BOTH the envelope's attestationReport string (what isSampleAttestationReport
    // checks) AND rawReportBytes (what's actually parsed) -- the real CLI decodes rawReportBytes FROM
    // envelope.attestationReport, so a genuine sample run has both fields carry the same marker bytes. This
    // proves allowSample truly lets execution proceed PAST the sample check into the real pipeline (which
    // then correctly fails on the too-short buffer), rather than short-circuiting to a fake success.
    const sampleBytes = Buffer.from("LOOPOVER-SAMPLE-ATTESTATION-v1:x");
    const input = baseInput({ allowSample: true, rawReportBytes: sampleBytes });
    input.envelope = { ...input.envelope, attestationReport: sampleBytes.toString("base64") };
    const result = verifyAttestedRun(input);
    expect(result).toEqual({ verified: false, failureClass: "malformed_report", reason: expect.stringContaining("expected exactly 1184 bytes") });
  });

  it("rejects a report buffer of the wrong size as malformed_report", () => {
    const result = verifyAttestedRun(baseInput({ rawReportBytes: new Uint8Array(10) }));
    expect(result).toEqual({ verified: false, failureClass: "malformed_report", reason: expect.stringContaining("expected exactly 1184 bytes") });
  });

  it("rejects a supplied ARK that does not match the pinned, vendored root", () => {
    const result = verifyAttestedRun(baseInput({ pinnedArkCertPem: askCertPem }));
    expect(result).toEqual({ verified: false, failureClass: "chain_untrusted", reason: expect.stringContaining("does not match the pinned, vendored root") });
  });

  it("rejects a pinned root that is byte-identical to the supplied ARK but is not actually self-signed", () => {
    // The ASK is a real, validly-signed certificate -- just not a self-signed root. Supplying it as BOTH
    // arkCertPem and pinnedArkCertPem passes the byte-identity check trivially (they're the same string), so
    // this specifically isolates and exercises the self-signature check that comes right after it.
    const result = verifyAttestedRun(baseInput({ arkCertPem: askCertPem, pinnedArkCertPem: askCertPem }));
    expect(result).toEqual({ verified: false, failureClass: "chain_untrusted", reason: expect.stringContaining("not self-signed") });
  });

  it("rejects an ASK not signed by the pinned ARK (wrong intermediate)", () => {
    // Use the VCEK cert (not a CA, and not signed by this ARK) in place of a real ASK -- fails the ASK-signed-by-ARK check.
    const result = verifyAttestedRun(baseInput({ askCertPem: vcekCertPem }));
    expect(result).toEqual({ verified: false, failureClass: "chain_untrusted", reason: expect.stringContaining("ASK certificate was not signed by the pinned ARK") });
  });

  it("rejects a VCEK not signed by the verified ASK", () => {
    // Swap in the ARK as a stand-in "VCEK" -- structurally a certificate, but never signed by the real ASK.
    const result = verifyAttestedRun(baseInput({ vcekCertPem: arkCertPem }));
    expect(result.verified).toBe(false);
    if (result.verified) return;
    // Signature verification against a real EC key is still attempted downstream in principle, but chain
    // trust is checked first, so this must be caught here.
    expect(result.failureClass).toBe("chain_untrusted");
  });

  it("rejects a report whose signature does not verify against the trusted VCEK (bytes corrupted after signing)", () => {
    const tampered = Buffer.from(buildSignedReport());
    tampered[10] = ((tampered[10] as number) ^ 0xff) & 0xff; // inside the signed region, outside any content field this test also checks
    const result = verifyAttestedRun(baseInput({ rawReportBytes: tampered }));
    expect(result).toEqual({ verified: false, failureClass: "signature_invalid", reason: expect.stringContaining("does not verify against the trusted VCEK") });
  });

  it("catches report_data tampering as signature_invalid, not report_data_mismatch -- report_data is itself inside the signed region, so corrupting it after signing invalidates the signature first", () => {
    const tampered = Buffer.from(buildSignedReport());
    tampered[0x50] = ((tampered[0x50] as number) ^ 0xff) & 0xff;
    const result = verifyAttestedRun(baseInput({ rawReportBytes: tampered }));
    expect(result).toEqual({ verified: false, failureClass: "signature_invalid", reason: expect.any(String) });
  });

  it("rejects a report whose reported_tcb does not match the VCEK certificate's provisioned TCB", () => {
    const wrongTcbReport = buildSignedReport({ tcb: [9, 9, 0, 0, 0, 0, 9, 9] });
    const result = verifyAttestedRun(baseInput({ rawReportBytes: wrongTcbReport }));
    expect(result).toEqual({
      verified: false,
      failureClass: "tcb_mismatch",
      reason: "report's reported_tcb (bootloader=9 tee=9 snp=9 microcode=9) does not match the VCEK certificate's provisioned TCB (bootloader=3 tee=5 snp=9 microcode=200)",
    });
  });

  it("rejects a report whose measurement does not match the expected pinned digest", () => {
    const result = verifyAttestedRun(baseInput({ expectedMeasurementHex: "ff".repeat(48) }));
    expect(result).toEqual({
      verified: false,
      failureClass: "measurement_mismatch",
      reason: `report measurement ${MEASUREMENT_HEX} does not match the expected pinned digest ${"ff".repeat(48)}`,
    });
  });

  it("uppercase expected-measurement input is compared case-insensitively", () => {
    const result = verifyAttestedRun(baseInput({ expectedMeasurementHex: MEASUREMENT_HEX.toUpperCase() }));
    expect(result).toEqual({ verified: true });
  });

  it("rejects a report_data mismatch when the envelope's OWN claimed binding fields disagree with what the report was actually signed over", () => {
    // Sign a report with a DIFFERENT corpus checksum than what this test then asks the verifier to re-derive
    // report_data from -- the report's report_data field itself is self-consistent and signed, but the
    // caller-supplied corpusChecksum used for re-derivation doesn't match what was actually bound.
    const otherReportData = buildAttestationReportData({ corpusChecksum: "9".repeat(64), headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID });
    const report = buildSignedReport({ reportDataHex: otherReportData });
    const result = verifyAttestedRun(baseInput({ rawReportBytes: report }));
    expect(result).toEqual({
      verified: false,
      failureClass: "report_data_mismatch",
      reason: expect.stringContaining("does not match the report's own report_data field"),
    });
  });
});

describe("formatCaughtError", () => {
  it("returns a real Error's own message", () => {
    expect(formatCaughtError(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error throw (a thrown string, however unusual in practice)", () => {
    expect(formatCaughtError("plain string throw")).toBe("plain string throw");
  });
});

describe("readVcekTcbFromCertificate", () => {
  it("throws when a required AMD SVN extension is missing (e.g. reading it off the ASK, which carries none of them)", () => {
    const der = new Uint8Array(
      Buffer.from(
        askCertPem
          .split("\n")
          .filter((line) => line && !line.includes("BEGIN") && !line.includes("END"))
          .join(""),
        "base64",
      ),
    );
    expect(() => readVcekTcbFromCertificate(der)).toThrow(/missing AMD SVN extension for bootloaderSpl/);
  });
});
