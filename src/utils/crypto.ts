export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyGitHubSignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
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
  if (leftBytes.length !== rightBytes.length) return false;
  let result = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    result |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return result === 0;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return new Uint8Array();
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
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
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
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
  return new TextDecoder().decode(decrypted);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
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
