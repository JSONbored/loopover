// AMD SEV-SNP ATTESTATION_REPORT binary parser (#9212, epic #8534). Every byte offset and field size below is
// taken from -- and cross-checked against -- google/go-sev-guest's abi package (a maintained, production
// attestation-verification library from Google, not derived from memory of AMD's PDF spec alone):
// https://github.com/google/go-sev-guest/blob/main/abi/abi.go
//
// Pure parsing only: no cryptographic verification happens here (that's verify-attested-run-core.ts's job),
// so this module can be exhaustively tested with hand-built byte buffers, no real hardware or real signing
// key required.
const REPORT_SIZE = 0x4a0; // 1184 bytes
const SIGNATURE_OFFSET = 0x2a0; // everything before this offset is what the VCEK signature covers
const SIGNATURE_SIZE = REPORT_SIZE - SIGNATURE_OFFSET; // 512-byte signature structure (only 144 bytes used)
const ECDSA_RS_COMPONENT_SIZE = 72; // each of R and S occupies a 72-byte, AMD-little-endian-padded field
const REPORT_DATA_SIZE = 64;
const MEASUREMENT_SIZE = 48;
const TCB_VERSION_SIZE = 8;

const OFFSET_VERSION = 0x00;
const OFFSET_SIGNATURE_ALGO = 0x34;
const OFFSET_CURRENT_TCB = 0x38;
const OFFSET_REPORT_DATA = 0x50;
const OFFSET_MEASUREMENT = 0x90;
const OFFSET_REPORTED_TCB = 0x180;
const OFFSET_CHIP_ID = 0x1a0;
const CHIP_ID_SIZE = 64;

/** AMD's numeric signature-algorithm identifier for ECDSA-P384-SHA384 -- the only algorithm this parser (or
 *  any current SEV-SNP deployment) needs to recognize; any other value is a report this parser refuses to
 *  interpret rather than silently guess at. */
const SIGNATURE_ALGO_ECDSA_P384_SHA384 = 1;

export type SnpTcbVersion = {
  bootloaderSpl: number;
  teeSpl: number;
  snpSpl: number;
  microcodeSpl: number;
};

export type ParsedSnpReport = {
  version: number;
  reportData: Uint8Array;
  measurement: Uint8Array;
  currentTcb: SnpTcbVersion;
  reportedTcb: SnpTcbVersion;
  chipId: Uint8Array;
  /** The exact byte range the VCEK signature covers -- `report[0:SIGNATURE_OFFSET]`, per AMD's ABI. Exposed
   *  directly (rather than making a caller re-slice) so a verifier can never accidentally hash the wrong
   *  range. */
  signedBytes: Uint8Array;
  /** R \|\| S, 48 bytes each, big-endian -- ready for `crypto.verify(..., { dsaEncoding: "ieee-p1363" })`
   *  against a P-384 public key. See {@link toIeeeP1363Signature}'s own doc comment for the conversion. */
  signatureIeeeP1363: Uint8Array;
};

/**
 * Decompose an 8-byte packed TCB_VERSION into its four named SVN fields. Byte layout (bootloader = bits 0-7,
 * i.e. the field's OWN byte 0, up through microcode = bits 56-63, byte 7) is taken from go-sev-guest's
 * `DecomposeTCBVersion` -- byte positions, not bit-shifts, since `tcbBytes` here is already the raw 8-byte
 * slice in its on-the-wire (little-endian field) order.
 */
export function decomposeTcbVersion(tcbBytes: Uint8Array): SnpTcbVersion {
  if (tcbBytes.length !== TCB_VERSION_SIZE) {
    throw new Error(`decomposeTcbVersion: expected ${TCB_VERSION_SIZE} bytes, got ${tcbBytes.length}`);
  }
  return {
    bootloaderSpl: tcbBytes[0] as number,
    teeSpl: tcbBytes[1] as number,
    // bytes 2-5 are reserved SPL slots (Spl4-Spl7 in go-sev-guest) with no defined meaning today; this
    // verifier has nothing to compare them against and does not surface them.
    snpSpl: tcbBytes[6] as number,
    microcodeSpl: tcbBytes[7] as number,
  };
}

/**
 * Convert the report's raw 144-byte-of-512 ECDSA signature structure into the 96-byte (48+48) big-endian
 * IEEE-P1363 form `crypto.verify` expects. AMD stores R and S as two 72-byte fields, each holding a
 * LITTLE-ENDIAN integer (the true P-384 value is 48 bytes; the remaining 24 bytes are zero padding at the
 * field's high-order end, which -- because the field is little-endian -- means the padding sits at the END
 * of the 72-byte slice as stored on disk). Reversing each full 72-byte slice yields a 72-byte BIG-ENDIAN
 * integer whose leading 24 bytes are now the (zero) padding and whose trailing 48 bytes are the real value --
 * so the final 48 bytes of the reversed slice is exactly the value IEEE-P1363 wants. This mirrors
 * go-sev-guest's `ReportToSignatureDER`, which reverses the same two 72-byte slices before treating them as
 * big-endian integers (there the result feeds a DER SEQUENCE of two INTEGERs instead of IEEE-P1363, but the
 * byte-order conversion is identical either way).
 */
export function toIeeeP1363Signature(signatureStruct: Uint8Array): Uint8Array {
  if (signatureStruct.length !== SIGNATURE_SIZE) {
    throw new Error(`toIeeeP1363Signature: expected a ${SIGNATURE_SIZE}-byte signature structure, got ${signatureStruct.length}`);
  }
  const rField = signatureStruct.subarray(0, ECDSA_RS_COMPONENT_SIZE);
  const sField = signatureStruct.subarray(ECDSA_RS_COMPONENT_SIZE, ECDSA_RS_COMPONENT_SIZE * 2);
  const rBigEndian = Uint8Array.from(rField).reverse();
  const sBigEndian = Uint8Array.from(sField).reverse();
  const p384FieldSize = 48;
  const result = new Uint8Array(p384FieldSize * 2);
  result.set(rBigEndian.subarray(rBigEndian.length - p384FieldSize), 0);
  result.set(sBigEndian.subarray(sBigEndian.length - p384FieldSize), p384FieldSize);
  return result;
}

/**
 * Parse a raw 1184-byte SEV-SNP attestation report. Throws on any size or algorithm mismatch -- a caller
 * should treat that as "not a valid SNP report", never attempt a partial/best-effort read of a truncated or
 * unrecognized-algorithm buffer.
 */
export function parseSnpReport(report: Uint8Array): ParsedSnpReport {
  if (report.length !== REPORT_SIZE) {
    throw new Error(`parseSnpReport: expected exactly ${REPORT_SIZE} bytes, got ${report.length}`);
  }
  const view = new DataView(report.buffer, report.byteOffset, report.byteLength);
  const version = view.getUint32(OFFSET_VERSION, true);
  const signatureAlgo = view.getUint32(OFFSET_SIGNATURE_ALGO, true);
  if (signatureAlgo !== SIGNATURE_ALGO_ECDSA_P384_SHA384) {
    throw new Error(`parseSnpReport: unsupported signature algorithm ${signatureAlgo} (only ECDSA-P384-SHA384 / 1 is supported)`);
  }

  const signatureStruct = report.subarray(SIGNATURE_OFFSET, REPORT_SIZE);
  return {
    version,
    reportData: report.subarray(OFFSET_REPORT_DATA, OFFSET_REPORT_DATA + REPORT_DATA_SIZE),
    measurement: report.subarray(OFFSET_MEASUREMENT, OFFSET_MEASUREMENT + MEASUREMENT_SIZE),
    currentTcb: decomposeTcbVersion(report.subarray(OFFSET_CURRENT_TCB, OFFSET_CURRENT_TCB + TCB_VERSION_SIZE)),
    reportedTcb: decomposeTcbVersion(report.subarray(OFFSET_REPORTED_TCB, OFFSET_REPORTED_TCB + TCB_VERSION_SIZE)),
    chipId: report.subarray(OFFSET_CHIP_ID, OFFSET_CHIP_ID + CHIP_ID_SIZE),
    signedBytes: report.subarray(0, SIGNATURE_OFFSET),
    signatureIeeeP1363: toIeeeP1363Signature(signatureStruct),
  };
}

export const SNP_REPORT_SIZE = REPORT_SIZE;
