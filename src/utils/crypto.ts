export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyGitHubSignature(rawBody: string, signatureHeader: string | null, secret: string | undefined): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  if (!secret) return false;

  const expected = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return timingSafeEqualHex(actual, expected);
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (!leftBytes || !rightBytes) return false;
  if (leftBytes.length !== rightBytes.length) return false;
  let result = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    result |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return result === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// ─── Reversible secret encryption (AES-256-GCM) ─────────────────────────────────────────────────
// Used for maintainer BYOK provider keys (Anthropic/OpenAI) that MUST be recoverable in plaintext at
// AI-call time. The AES key is derived from the worker secret TOKEN_ENCRYPTION_SECRET via PBKDF2; a
// fresh random 12-byte IV is used per encryption so ciphertexts are unique and the GCM tag authenticates
// them. The plaintext key is never persisted, never logged, and never returned from the API.
//
// Envelope versions (stored as key_version alongside the row):
//   1 = legacy: a single constant KDF salt for every record (SECRET_KDF_SALT_V1).
//   2 = current: a fresh random per-record salt, stored beside the IV, so each record's AES key is
//       independently derived (defense-in-depth; decouples derived keys, eases future KDF rotation).
// Decryption keys off whether a per-record salt is present, so existing v1 rows (salt = null) keep
// decrypting with the constant salt.
const SECRET_KDF_SALT_V1 = new TextEncoder().encode("gittensory-secret-encryption-v1");
const SECRET_KEY_VERSION_CURRENT = 2;

async function deriveSecretAesKey(keyMaterial: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyMaterial), "PBKDF2", false, ["deriveKey"]);
  // salt is always a plain (never shared) ArrayBuffer view — the cast only narrows the TYPE for the UI
  // workspace's stricter DOM-lib Pbkdf2Params, which excludes SharedArrayBuffer from ArrayBufferLike.
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as Uint8Array<ArrayBuffer>, iterations: 100_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a secret with AES-256-GCM. Returns base64 ciphertext (incl. auth tag) + base64 IV + the
 * per-record salt (base64, null for the legacy v1 envelope) + envelope version. Production always uses
 * the current envelope; `version` is parameterized only so tests can produce legacy v1 ciphertexts.
 */
export async function encryptSecret(
  plaintext: string,
  keyMaterial: string,
  version: number = SECRET_KEY_VERSION_CURRENT,
): Promise<{ ciphertext: string; iv: string; salt: string | null; version: number }> {
  if (!keyMaterial) throw new Error("missing_encryption_secret");
  const saltBytes = version >= 2 ? crypto.getRandomValues(new Uint8Array(16)) : SECRET_KDF_SALT_V1;
  const key = await deriveSecretAesKey(keyMaterial, saltBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: base64Encode(new Uint8Array(encrypted)), iv: base64Encode(iv), salt: version >= 2 ? base64Encode(saltBytes) : null, version };
}

/**
 * Decrypt a secret produced by {@link encryptSecret}. Pass the stored per-record `salt` for v2 rows;
 * omit it (or pass null) for legacy v1 rows, which fall back to the constant salt. Throws if the
 * secret/IV/salt/ciphertext do not match.
 */
export async function decryptSecret(ciphertext: string, iv: string, keyMaterial: string, salt?: string | null): Promise<string> {
  if (!keyMaterial) throw new Error("missing_encryption_secret");
  const saltBytes = salt ? base64ToBytes(salt) : SECRET_KDF_SALT_V1;
  const key = await deriveSecretAesKey(keyMaterial, saltBytes);
  // These decoded byte arrays are always plain (never shared) ArrayBuffer views — the cast only narrows the
  // TYPE for the UI workspace's stricter DOM-lib AesGcmParams, which excludes SharedArrayBuffer.
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) as Uint8Array<ArrayBuffer> }, key, base64ToBytes(ciphertext) as Uint8Array<ArrayBuffer>);
  return new TextDecoder().decode(decrypted);
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ─── Draft user-token encryption (AES-256-GCM, single-string envelope) ───────────────────────────
// Ported from the reviewbot public draft-submission flow (LOOPOVER_REVIEW_DRAFT). Distinct from
// encryptSecret/decryptSecret above: this packs salt+iv+ciphertext into ONE `.`-joined base64url
// string so a single TEXT column (submission_user_tokens.encrypted_token) holds the full envelope,
// and derives the AES key via HKDF (not PBKDF2). The user's short-lived GitHub OAuth token is the
// only plaintext stored, and only until the fork PR is opened (then it is consumed). Never logged.

function base64UrlDecode(value: string): Uint8Array {
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveDraftTokenAesKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  // salt is always a plain (never shared) ArrayBuffer view — the cast only narrows the TYPE for the UI
  // workspace's stricter DOM-lib HkdfParams, which excludes SharedArrayBuffer from ArrayBufferLike.
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: new TextEncoder().encode("gittensory:draft-user-token:v1") },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-256-GCM encrypt -> base64url(salt).base64url(iv).base64url(ciphertext). */
export async function encryptDraftToken(secret: string, plaintext: string): Promise<string> {
  if (!secret) throw new Error("missing_encryption_secret");
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveDraftTokenAesKey(secret, salt), new TextEncoder().encode(plaintext));
  return `${base64UrlEncode(salt)}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/** Decrypt a payload produced by {@link encryptDraftToken}. Throws on any tamper/mismatch. */
export async function decryptDraftToken(secret: string, encrypted: string): Promise<string> {
  if (!secret) throw new Error("missing_encryption_secret");
  const parts = encrypted.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("Invalid encrypted payload.");
  try {
    // These decoded byte arrays are always plain (never shared) ArrayBuffer views — the casts only narrow
    // the TYPE for the UI workspace's stricter DOM-lib AesGcmParams, which excludes SharedArrayBuffer.
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(parts[1]) as Uint8Array<ArrayBuffer> },
      await deriveDraftTokenAesKey(secret, base64UrlDecode(parts[0])),
      base64UrlDecode(parts[2]) as Uint8Array<ArrayBuffer>,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Invalid encrypted payload.");
  }
}

/** Random URL-safe token (default 32 bytes) — used as the OAuth CSRF state for a draft. */
export function randomDraftToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64UrlEncode(data);
}

/** Prefixed opaque id, e.g. `draft_<hex>`. */
export function newDraftId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function signRs256Jwt(payload: Record<string, string | number>, privateKeyPem: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importPkcs8PrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function importPkcs8PrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const normalized = privateKeyPem.replace(/\\n/g, "\n");
  const isPkcs1Rsa = normalized.includes("-----BEGIN RSA PRIVATE KEY-----");
  const base64 = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const bytes = isPkcs1Rsa ? wrapPkcs1RsaPrivateKey(base64ToBytes(base64)) : base64ToBytes(base64);
  // bytes is always a plain (never shared) ArrayBuffer view — the cast only narrows the TYPE for the UI
  // workspace's stricter DOM-lib importKey overload, which excludes SharedArrayBuffer from ArrayBufferLike.
  return crypto.subtle.importKey(
    "pkcs8",
    bytes as Uint8Array<ArrayBuffer>,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function wrapPkcs1RsaPrivateKey(pkcs1Der: Uint8Array): Uint8Array {
  const version = der(0x02, new Uint8Array([0]));
  const rsaEncryptionOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const nullParam = new Uint8Array([0x05, 0x00]);
  const algorithm = der(0x30, concatBytes(rsaEncryptionOid, nullParam));
  const privateKey = der(0x04, pkcs1Der);
  return der(0x30, concatBytes(version, algorithm, privateKey));
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(content.length), content);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
