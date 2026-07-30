// The one serialization rule every LoopOver commitment is computed under (#9723).
//
// `canonicalJson` + `sha256Hex` define every published digest in this system: `recordDigest` on a decision
// record, `corpusChecksum` on an eval-score record, the eval-corpus checksum, and the anchor payload's own
// digest. They lived in `src/review/decision-record.ts` -- inside the Worker, which is not published --
// so the third-party verifier #9723 asks for could not recompute a single one of those digests without a
// repo checkout, and the "no repo checkout required beyond npx" requirement was unsatisfiable by
// construction.
//
// They live HERE, in the leaf contract package, for the same reason every other shared vocabulary does:
// this is the one module both the Worker and the separately-published CLI can import. `decision-record.ts`
// re-exports them, so every existing call site is unchanged and there is exactly one definition.
//
// DO NOT "improve" the serialization. These bytes are the preimage of digests already published, anchored,
// and quoted back to us by outside readers; any change silently invalidates every commitment ever made.
// The rules, stated so a reimplementation in another language can match them exactly:
//
//   • Object keys are sorted by JS string order (UTF-16 code unit), ascending.
//   • Keys whose value is `undefined` are OMITTED. A top-level `undefined` serializes as `null`.
//   • No whitespace anywhere; strings and numbers use `JSON.stringify`'s own encoding.
//   • Arrays keep their order -- ordering an array is the caller's job, not the serializer's.

/**
 * Deterministic JSON: sorted keys, `undefined` properties dropped, no whitespace.
 *
 * Throws on values JSON cannot represent (functions, symbols, bigints) rather than coercing them --
 * a silent wrong digest is far worse than a loud failure, because it validates as "just a mismatch".
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  // Functions/symbols/bigints have no JSON meaning; refusing loudly beats a silent wrong digest.
  throw new Error(`canonicalJson: unsupported value type "${typeof value}"`);
}

/** SHA-256 of `text` as lowercase hex, via Web Crypto -- present in both Workers and Node 22. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The digest of a value under the canonical serialization: `sha256Hex(canonicalJson(value))`. */
export async function contentDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
