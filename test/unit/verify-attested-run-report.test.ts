import { type KeyObject, generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SNP_REPORT_SIZE, decomposeTcbVersion, parseSnpReport, toIeeeP1363Signature } from "../../scripts/verify-attested-run-report";

const OFFSET_VERSION = 0x00;
const OFFSET_SIGNATURE_ALGO = 0x34;
const OFFSET_CURRENT_TCB = 0x38;
const OFFSET_REPORT_DATA = 0x50;
const OFFSET_MEASUREMENT = 0x90;
const OFFSET_REPORTED_TCB = 0x180;
const OFFSET_CHIP_ID = 0x1a0;
const OFFSET_SIGNATURE = 0x2a0;
const P384_FIELD_SIZE = 48;
const AMD_RS_FIELD_SIZE = 72;

/** AMD's little-endian, zero-padded 72-byte encoding of one big-endian 48-byte ECDSA component -- the exact
 *  inverse of {@link toIeeeP1363Signature}'s own conversion, used here only to construct realistic test
 *  reports (production code never needs to go this direction). */
function toAmdEcdsaField(bigEndian48: Buffer): Buffer {
  const padded = Buffer.concat([Buffer.alloc(AMD_RS_FIELD_SIZE - P384_FIELD_SIZE), bigEndian48]);
  return Buffer.from(padded).reverse();
}

/** Build a real, byte-correct 1184-byte SNP report, genuinely ECDSA-P384-SHA384-signed with a freshly
 *  generated key pair, and encoded into AMD's exact on-the-wire little-endian signature format. Returns the
 *  report alongside the public key and the plaintext values placed into it, so a test can assert the parser
 *  recovered every field correctly AND that the recovered signature verifies with real cryptography -- never
 *  a mocked "verification" that can't actually fail. */
function buildSignedTestReport(
  overrides: { version?: number; signatureAlgo?: number; corruptSignedByte?: boolean } = {},
): {
  report: Buffer;
  publicKey: KeyObject;
  reportData: Buffer;
  measurement: Buffer;
  chipId: Buffer;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  const report = Buffer.alloc(SNP_REPORT_SIZE);
  report.writeUInt32LE(overrides.version ?? 2, OFFSET_VERSION);
  report.writeUInt32LE(overrides.signatureAlgo ?? 1, OFFSET_SIGNATURE_ALGO);
  Buffer.from([3, 5, 0, 0, 0, 0, 9, 200]).copy(report, OFFSET_CURRENT_TCB);
  Buffer.from([1, 2, 0, 0, 0, 0, 3, 100]).copy(report, OFFSET_REPORTED_TCB);
  const reportData = Buffer.alloc(64, 0xab);
  reportData.copy(report, OFFSET_REPORT_DATA);
  const measurement = Buffer.alloc(48, 0xcd);
  measurement.copy(report, OFFSET_MEASUREMENT);
  const chipId = Buffer.alloc(64, 0xef);
  chipId.copy(report, OFFSET_CHIP_ID);

  if (overrides.corruptSignedByte) report[0] = ((report[0] as number) ^ 0xff) & 0xff;

  const signedBytes = report.subarray(0, OFFSET_SIGNATURE);
  const p1363Sig = sign("sha384", signedBytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const rAmd = toAmdEcdsaField(p1363Sig.subarray(0, P384_FIELD_SIZE));
  const sAmd = toAmdEcdsaField(p1363Sig.subarray(P384_FIELD_SIZE, P384_FIELD_SIZE * 2));
  const sigStruct = Buffer.alloc(SNP_REPORT_SIZE - OFFSET_SIGNATURE);
  rAmd.copy(sigStruct, 0);
  sAmd.copy(sigStruct, AMD_RS_FIELD_SIZE);
  sigStruct.copy(report, OFFSET_SIGNATURE);

  return { report, publicKey, reportData, measurement, chipId };
}

describe("parseSnpReport + toIeeeP1363Signature (real ECDSA-P384-SHA384 round trip)", () => {
  it("recovers every field correctly, and the extracted signature genuinely verifies against the real public key", () => {
    const { report, publicKey, reportData, measurement, chipId } = buildSignedTestReport();
    const parsed = parseSnpReport(report);

    expect(parsed.version).toBe(2);
    expect(Buffer.compare(parsed.reportData, reportData)).toBe(0);
    expect(Buffer.compare(parsed.measurement, measurement)).toBe(0);
    expect(Buffer.compare(parsed.chipId, chipId)).toBe(0);
    expect(parsed.currentTcb).toEqual({ bootloaderSpl: 3, teeSpl: 5, snpSpl: 9, microcodeSpl: 200 });
    expect(parsed.reportedTcb).toEqual({ bootloaderSpl: 1, teeSpl: 2, snpSpl: 3, microcodeSpl: 100 });
    expect(Buffer.compare(parsed.signedBytes, report.subarray(0, 0x2a0))).toBe(0);
    expect(parsed.signatureIeeeP1363).toHaveLength(96);

    // The real cryptographic assertion: genuine ECDSA-P384-SHA384 verification, not a structural check.
    const isValid = verify("sha384", parsed.signedBytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, parsed.signatureIeeeP1363);
    expect(isValid).toBe(true);
  });

  it("produces a signature that correctly FAILS verification when the signed bytes were tampered with after signing", () => {
    const { report, publicKey } = buildSignedTestReport();
    const parsed = parseSnpReport(report);
    const tamperedSignedBytes = Buffer.from(parsed.signedBytes);
    tamperedSignedBytes[0] = ((tamperedSignedBytes[0] as number) ^ 0xff) & 0xff;

    const isValid = verify("sha384", tamperedSignedBytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, parsed.signatureIeeeP1363);
    expect(isValid).toBe(false);
  });

  it("produces a signature that correctly fails verification against the WRONG public key", () => {
    const { report } = buildSignedTestReport();
    const { publicKey: wrongPublicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const parsed = parseSnpReport(report);

    const isValid = verify("sha384", parsed.signedBytes, { key: wrongPublicKey, dsaEncoding: "ieee-p1363" }, parsed.signatureIeeeP1363);
    expect(isValid).toBe(false);
  });

  it("throws on a report that is not exactly 1184 bytes", () => {
    expect(() => parseSnpReport(new Uint8Array(100))).toThrow(/expected exactly 1184 bytes/);
    expect(() => parseSnpReport(new Uint8Array(SNP_REPORT_SIZE + 1))).toThrow(/expected exactly 1184 bytes/);
  });

  it("throws on an unsupported signature algorithm rather than silently misinterpreting the signature", () => {
    const { report } = buildSignedTestReport({ signatureAlgo: 99 });
    expect(() => parseSnpReport(report)).toThrow(/unsupported signature algorithm 99/);
  });
});

describe("toIeeeP1363Signature", () => {
  it("throws on a signature structure of the wrong length", () => {
    expect(() => toIeeeP1363Signature(new Uint8Array(10))).toThrow(/expected a 512-byte signature structure/);
  });
});

describe("decomposeTcbVersion", () => {
  it("maps each byte position to its documented field, ignoring the reserved middle bytes", () => {
    expect(decomposeTcbVersion(Uint8Array.from([9, 8, 0xff, 0xff, 0xff, 0xff, 7, 6]))).toEqual({
      bootloaderSpl: 9,
      teeSpl: 8,
      snpSpl: 7,
      microcodeSpl: 6,
    });
  });

  it("throws on a value that isn't exactly 8 bytes", () => {
    expect(() => decomposeTcbVersion(new Uint8Array(7))).toThrow(/expected 8 bytes, got 7/);
    expect(() => decomposeTcbVersion(new Uint8Array(9))).toThrow(/expected 8 bytes, got 9/);
  });
});
