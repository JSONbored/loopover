import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { encodeOid, findExtensionValue, parseDer, readSmallDerInteger } from "../../scripts/verify-attested-run-der";

// A minimal, hand-verified DER encoding: SEQUENCE { INTEGER 1, OCTET STRING "hi" }. Built by hand rather than
// via any library, so this test suite has no circular dependency on the code it's testing.
const SIMPLE_SEQUENCE = Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x04, 0x02, 0x68, 0x69]);
const TAG_OID = 0x06;

describe("parseDer", () => {
  it("parses a simple SEQUENCE and both its primitive children", () => {
    const node = parseDer(SIMPLE_SEQUENCE);
    expect(node.tag).toBe(0x30);
    expect(node.children).toHaveLength(2);
    expect(node.children[0]?.tag).toBe(0x02); // INTEGER
    expect(node.children[1]?.tag).toBe(0x04); // OCTET STRING
    expect(SIMPLE_SEQUENCE.subarray(node.children[1]?.valueStart, node.children[1]?.valueEnd)).toEqual(Uint8Array.from([0x68, 0x69]));
  });

  it("parses a long-form length (>127 bytes) correctly", () => {
    const value = new Uint8Array(200).fill(0xaa);
    // long-form length: 0x81 (one length-of-length byte follows) then 0xC8 (200)
    const buffer = Uint8Array.from([0x04, 0x81, 0xc8, ...value]);
    const node = parseDer(buffer);
    expect(node.tag).toBe(0x04);
    expect(node.valueEnd - node.valueStart).toBe(200);
  });

  it("parses a two-byte long-form length", () => {
    const value = new Uint8Array(300).fill(0xbb);
    // 300 = 0x012C; long-form: 0x82 (two length-of-length bytes) then 0x01 0x2C
    const buffer = Uint8Array.from([0x04, 0x82, 0x01, 0x2c, ...value]);
    const node = parseDer(buffer);
    expect(node.valueEnd - node.valueStart).toBe(300);
  });

  it("throws on a truncated tag/length header", () => {
    expect(() => parseDer(Uint8Array.from([0x30]))).toThrow(/truncated tag\/length/);
  });

  it("throws on indefinite-length encoding (0x80 length byte, unsupported in strict DER)", () => {
    expect(() => parseDer(Uint8Array.from([0x30, 0x80, 0x00, 0x00]))).toThrow(/indefinite length not supported/);
  });

  it("throws on a truncated long-form length", () => {
    expect(() => parseDer(Uint8Array.from([0x04, 0x82, 0x01]))).toThrow(/truncated long-form length/);
  });

  it("throws when the declared value length extends past the buffer", () => {
    expect(() => parseDer(Uint8Array.from([0x04, 0x05, 0x01, 0x02]))).toThrow(/extends past buffer end/);
  });
});

describe("encodeOid", () => {
  it("matches the real DER bytes of a well-known OID (sha384, 2.16.840.1.101.3.4.2.2) verified against a live AMD KDS certificate", () => {
    // Cross-checked byte-for-byte against packages/loopover-engine test fixtures are not needed here -- this
    // exact hex was independently confirmed against a real, live-fetched Milan ASK certificate's AlgorithmIdentifier
    // (offset 39, length 9) during development; see this module's own header comment.
    expect(Buffer.from(encodeOid([2, 16, 840, 1, 101, 3, 4, 2, 2])).toString("hex")).toBe("608648016503040202");
  });

  it("matches AMD's KDS SVN OID arc (1.3.6.1.4.1.3704.1.3.1, bootloader SPL)", () => {
    // 3704 requires multi-byte base-128 encoding (3704 = 0b111001110111000 -> 0xAC 0x38); this is the arc
    // that exercises the multi-byte encoding path, unlike sha384's OID above (whose arcs are all single-byte).
    expect(Buffer.from(encodeOid([1, 3, 6, 1, 4, 1, 3704, 1, 3, 1])).toString("hex")).toBe("2b060104019c78010301");
  });

  it("encodes a zero-valued arc as a single zero byte", () => {
    expect(Buffer.from(encodeOid([2, 5, 29, 0])).toString("hex")).toBe("551d00");
  });

  it("throws with fewer than two arcs", () => {
    expect(() => encodeOid([1])).toThrow(/at least two arcs/);
  });

  it("throws on a negative arc", () => {
    expect(() => encodeOid([1, 3, -1])).toThrow(/negative arc/);
  });
});

/** PEM -> raw DER, matching how Node's own X509Certificate accepts either form -- this module's real callers
 *  always operate on DER extracted from a certificate exactly this way. */
function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .split("\n")
    .filter((line) => line && !line.includes("BEGIN") && !line.includes("END"))
    .join("");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("findExtensionValue (against the real, vendored AMD KDS Milan ASK certificate)", () => {
  const der = pemToDer(readFileSync("scripts/verify-attested-run/certs/milan-ask.pem", "utf8"));
  const tree = parseDer(der);

  it("finds a present standard extension (basicConstraints, 2.5.29.19) and decodes its known content", () => {
    const value = findExtensionValue(der, tree, encodeOid([2, 5, 29, 19]));
    expect(value).not.toBeNull();
    // SEQUENCE(6) { BOOLEAN(1) 0xff=true, INTEGER(1) 0x00 } -- matches `openssl x509 -text`'s own report for
    // this certificate: "CA:TRUE, pathlen:0".
    expect(Buffer.from(value ?? []).toString("hex")).toBe("30060101ff020100");
  });

  it("finds the CRL distribution point extension (2.5.29.31) and confirms its expected length", () => {
    const value = findExtensionValue(der, tree, encodeOid([2, 5, 29, 31]));
    expect(value).not.toBeNull();
    expect(value?.length).toBe(51);
  });

  it("returns null for an AMD KDS SVN OID that is genuinely absent from an ASK certificate (those OIDs only appear on VCEK leaf certs)", () => {
    expect(findExtensionValue(der, tree, encodeOid([1, 3, 6, 1, 4, 1, 3704, 1, 3, 1]))).toBeNull();
  });

  it("returns null for a syntactically valid but entirely unrelated OID", () => {
    expect(findExtensionValue(der, tree, encodeOid([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("returns null (never throws) for a malformed 2-child Extension whose second child isn't an OCTET STRING and has no third child to fall back to", () => {
    const targetOid = encodeOid([1, 2, 3]);
    // SEQUENCE { OID 1.2.3, INTEGER 1 } -- an OID match, but not a well-formed Extension (no OCTET STRING
    // anywhere), which is exactly the shape that leaves `extnValueNode` undefined inside the function.
    const oidBytes = Array.from(targetOid);
    const malformed = Uint8Array.from([0x30, 2 + oidBytes.length + 3, TAG_OID, oidBytes.length, ...oidBytes, 0x02, 0x01, 0x01]);
    expect(findExtensionValue(malformed, parseDer(malformed), targetOid)).toBeNull();
  });
});

describe("readSmallDerInteger", () => {
  it("reads single-byte values 0 and 127 without padding", () => {
    expect(readSmallDerInteger(Uint8Array.from([0x02, 0x01, 0x00]))).toBe(0);
    expect(readSmallDerInteger(Uint8Array.from([0x02, 0x01, 0x7f]))).toBe(127);
  });

  it("reads zero-padded two-byte values 128, 200, and 255 (high bit requires a leading 0x00)", () => {
    expect(readSmallDerInteger(Uint8Array.from([0x02, 0x02, 0x00, 0x80]))).toBe(128);
    expect(readSmallDerInteger(Uint8Array.from([0x02, 0x02, 0x00, 0xc8]))).toBe(200);
    expect(readSmallDerInteger(Uint8Array.from([0x02, 0x02, 0x00, 0xff]))).toBe(255);
  });

  it("rejects a single high-bit-set byte as negative (0x02 0x01 0xFF means -1 in DER, not 255)", () => {
    expect(() => readSmallDerInteger(Uint8Array.from([0x02, 0x01, 0xff]))).toThrow(/negative INTEGER/);
  });

  it("rejects an out-of-uint8-range INTEGER (3+ value bytes)", () => {
    expect(() => readSmallDerInteger(Uint8Array.from([0x02, 0x03, 0x01, 0x00, 0x00]))).toThrow(/out of uint8 range/);
  });

  it("rejects a two-byte value whose leading byte isn't the required zero pad", () => {
    expect(() => readSmallDerInteger(Uint8Array.from([0x02, 0x02, 0x01, 0x02]))).toThrow(/out of uint8 range/);
  });

  it("rejects an empty INTEGER value", () => {
    expect(() => readSmallDerInteger(Uint8Array.from([0x02, 0x00]))).toThrow(/empty INTEGER/);
  });

  it("rejects a non-INTEGER tag", () => {
    expect(() => readSmallDerInteger(Uint8Array.from([0x04, 0x01, 0x00]))).toThrow(/expected an INTEGER/);
  });

  it("rejects trailing bytes after the INTEGER", () => {
    expect(() => readSmallDerInteger(Uint8Array.from([0x02, 0x01, 0x00, 0xff]))).toThrow(/unexpected trailing bytes/);
  });
});
