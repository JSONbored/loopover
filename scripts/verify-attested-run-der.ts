// Minimal DER/BER reader (#9212, epic #8534) -- ONLY what's needed to pull a named X.509 extension's raw
// value out of a certificate's DER bytes, and to read a small unsigned DER INTEGER out of that value. This is
// deliberately NOT a general ASN.1 library: no dependency is added for it (a smaller, auditable trusted
// computing base matters more here than convenience -- this module's whole job is verifying trust, so it
// should not itself require trusting an unaudited third-party parser), and every function is scoped to the
// exact shapes AMD's KDS certificates actually use, per the X.509 Extension grammar (RFC 5280 §4.1):
//
//   Extension ::= SEQUENCE { extnID OBJECT IDENTIFIER, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
//
// Every extension value AMD's KDS defines under 1.3.6.1.4.1.3704.1.3.* (the per-component SVN fields this
// module exists to read) is a DER INTEGER 0-255 wrapped in that OCTET STRING -- verified byte-for-byte against
// google/go-sev-guest's kds/kds.go asn1U8 (which does the equivalent Go-side unmarshal) and against a real,
// live-fetched AMD KDS certificate's raw DER bytes (the OID encoding this module's tests pin was checked
// against the actual bytes in a real Milan ASK certificate's SHA-384 AlgorithmIdentifier, not derived from
// memory alone).

const TAG_INTEGER = 0x02;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const TAG_OCTET_STRING = 0x04;
const LONG_LENGTH_MASK = 0x80;
const LONG_LENGTH_COUNT_MASK = 0x7f;
const OID_ARC_CONTINUATION_BIT = 0x80;
const OID_ARC_VALUE_MASK = 0x7f;

/** One parsed DER TLV: `tag`, the byte range of its VALUE (not including the tag/length header), and (for a
 *  constructed tag -- SEQUENCE, SET, or a context-specific `[N]` wrapper) its immediate children, parsed one
 *  level deep. Primitive tags (INTEGER, OID, OCTET STRING, ...) carry no children -- their bytes are read
 *  directly by the typed helpers below. */
export type DerNode = {
  tag: number;
  valueStart: number;
  valueEnd: number;
  children: DerNode[];
};

const CONSTRUCTED_BIT = 0x20;

/** Parse one DER TLV starting at `offset`. Throws on truncated or malformed length encoding -- a caller
 *  handling untrusted input should catch and treat that as "not a valid AMD certificate", never fall back
 *  to a partial/best-effort read. Recurses into constructed tags (bit 0x20 set) one call at a time, so the
 *  whole certificate is walked lazily rather than materializing a full parse tree up front. */
function readTlv(buffer: Uint8Array, offset: number): { node: DerNode; nextOffset: number } {
  if (offset + 2 > buffer.length) throw new Error(`DER: truncated tag/length at offset ${offset}`);
  const tag = buffer[offset] as number;
  let lengthOffset = offset + 1;
  const firstLengthByte = buffer[lengthOffset] as number;
  let length: number;
  if ((firstLengthByte & LONG_LENGTH_MASK) === 0) {
    length = firstLengthByte;
    lengthOffset += 1;
  } else {
    const byteCount = firstLengthByte & LONG_LENGTH_COUNT_MASK;
    if (byteCount === 0) throw new Error(`DER: indefinite length not supported at offset ${offset}`);
    if (lengthOffset + 1 + byteCount > buffer.length) throw new Error(`DER: truncated long-form length at offset ${offset}`);
    length = 0;
    for (let i = 0; i < byteCount; i += 1) {
      length = length * 256 + (buffer[lengthOffset + 1 + i] as number);
    }
    lengthOffset += 1 + byteCount;
  }
  const valueStart = lengthOffset;
  const valueEnd = valueStart + length;
  if (valueEnd > buffer.length) throw new Error(`DER: value extends past buffer end at offset ${offset}`);

  const children: DerNode[] = [];
  if ((tag & CONSTRUCTED_BIT) !== 0) {
    let childOffset = valueStart;
    while (childOffset < valueEnd) {
      const { node, nextOffset } = readTlv(buffer, childOffset);
      children.push(node);
      childOffset = nextOffset;
    }
  }
  return { node: { tag, valueStart, valueEnd, children }, nextOffset: valueEnd };
}

/** Parse a complete, single top-level DER value (an X.509 certificate is exactly this: one SEQUENCE). */
export function parseDer(buffer: Uint8Array): DerNode {
  const { node } = readTlv(buffer, 0);
  return node;
}

/** DER-encode an OID's dotted arcs (RFC 5280's `OBJECT IDENTIFIER` rule: first two arcs collapse into one
 *  byte as `40*arc0 + arc1`, every arc after that is base-128, most-significant-chunk-first, with the
 *  continuation bit set on every byte but the last of a multi-byte arc). Used only to build the search key
 *  this module compares against -- never to decode an arbitrary OID (this module never needs to render an
 *  unknown extension's OID back to a dotted string, only to recognize a small, fixed set of expected ones). */
export function encodeOid(arcs: readonly number[]): Uint8Array {
  if (arcs.length < 2) throw new Error("encodeOid: at least two arcs are required");
  const bytes: number[] = [(arcs[0] as number) * 40 + (arcs[1] as number)];
  for (const arc of arcs.slice(2)) {
    if (arc < 0) throw new Error(`encodeOid: negative arc ${arc}`);
    if (arc === 0) {
      bytes.push(0);
      continue;
    }
    const chunks: number[] = [];
    let remaining = arc;
    while (remaining > 0) {
      chunks.unshift(remaining & OID_ARC_VALUE_MASK);
      remaining = Math.floor(remaining / (OID_ARC_VALUE_MASK + 1));
    }
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i] = (chunks[i] as number) | OID_ARC_CONTINUATION_BIT;
    bytes.push(...chunks);
  }
  return new Uint8Array(bytes);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Find an X.509 extension's `extnValue` OCTET STRING contents, by OID, anywhere in a certificate's DER bytes.
 * Searches structurally (any SEQUENCE whose first child is an OID matching `targetOid`, followed by an
 * OCTET STRING -- optionally preceded by a BOOLEAN `critical` flag per the Extension grammar) rather than
 * assuming TBSCertificate's exact field layout, so it isn't sensitive to optional preceding fields
 * (issuerUniqueID/subjectUniqueID) this module doesn't otherwise need to understand.
 *
 * Returns `null` -- never throws -- when the extension isn't present; a genuinely malformed certificate
 * (one `parseDer` itself cannot walk) still throws from `parseDer`, which is the caller's signal to reject
 * the certificate outright rather than treat a parse failure as "extension absent".
 */
export function findExtensionValue(certificateDer: Uint8Array, node: DerNode, targetOid: Uint8Array): Uint8Array | null {
  if (node.tag === TAG_SEQUENCE && node.children.length >= 2) {
    const first = node.children[0] as DerNode;
    const second = node.children[1] as DerNode;
    if (first.tag === TAG_OID && bytesEqual(certificateDer.subarray(first.valueStart, first.valueEnd), targetOid)) {
      // extnValue is either children[1] (no critical flag present) or children[2] (critical flag present,
      // a BOOLEAN at children[1]) -- both are legal per the grammar's DEFAULT FALSE optional field.
      const extnValueNode = second.tag === TAG_OCTET_STRING ? second : node.children[2];
      if (extnValueNode && extnValueNode.tag === TAG_OCTET_STRING) {
        return certificateDer.subarray(extnValueNode.valueStart, extnValueNode.valueEnd);
      }
    }
  }
  for (const child of node.children) {
    const found = findExtensionValue(certificateDer, child, targetOid);
    if (found) return found;
  }
  return null;
}

/**
 * Read a DER INTEGER (0-255 only -- every AMD KDS SVN extension this module reads is defined as exactly this
 * shape) from an extension's raw `extnValue` OCTET STRING contents (as returned by {@link findExtensionValue}
 * -- note that value is itself the DER encoding of the INTEGER, e.g. `02 01 07`, not a bare number). Rejects
 * a negative value, a value above 255, or a leftover/malformed encoding explicitly rather than silently
 * truncating -- an out-of-range SVN byte is a certificate this module should refuse to trust, not coerce.
 */
export function readSmallDerInteger(extnValue: Uint8Array): number {
  const { node, nextOffset } = readTlv(extnValue, 0);
  if (nextOffset !== extnValue.length) throw new Error("readSmallDerInteger: unexpected trailing bytes");
  if (node.tag !== TAG_INTEGER) throw new Error(`readSmallDerInteger: expected an INTEGER, got tag 0x${node.tag.toString(16)}`);
  const valueBytes = extnValue.subarray(node.valueStart, node.valueEnd);
  if (valueBytes.length === 0) throw new Error("readSmallDerInteger: empty INTEGER");
  // A DER INTEGER left-pads with a single 0x00 byte only when needed to keep the value non-negative (i.e.
  // when the next byte's high bit is set); at most one such padding byte is ever valid.
  const firstByte = valueBytes[0] as number;
  if ((firstByte & 0x80) !== 0) throw new Error("readSmallDerInteger: negative INTEGER is not a valid SVN");
  if (valueBytes.length > 2 || (valueBytes.length === 2 && firstByte !== 0)) {
    throw new Error(`readSmallDerInteger: INTEGER out of uint8 range (${valueBytes.length} value bytes)`);
  }
  return valueBytes.length === 2 ? (valueBytes[1] as number) : firstByte;
}
