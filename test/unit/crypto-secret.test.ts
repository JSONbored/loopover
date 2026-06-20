import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  decryptSecret,
  encryptSecret,
  sha256Hex,
} from "../../src/utils/crypto";

describe("sha256Hex", () => {
  it("matches known SHA-256 vectors", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and returns lowercase 64-char hex", async () => {
    const first = await sha256Hex("gittensory");
    const second = await sha256Hex("gittensory");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different digests for different inputs", async () => {
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});

describe("base64UrlEncode", () => {
  it("encodes strings without padding and matches base64url of the UTF-8 bytes", () => {
    expect(base64UrlEncode("Hello")).toBe("SGVsbG8");
    expect(base64UrlEncode("")).toBe("");
  });

  it("encodes raw bytes using url-safe alphabet", () => {
    // 0xff,0xfe -> standard base64 "//4=" -> url-safe, unpadded "__4"
    expect(base64UrlEncode(new Uint8Array([0xff, 0xfe]))).toBe("__4");
  });

  it("never emits +, / or = padding characters", () => {
    const bytes = new Uint8Array(
      Array.from({ length: 64 }, (_, index) => index * 4),
    );
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("round-trips back to the original bytes when padding is restored", () => {
    const input = "the quick brown fox";
    const encoded = base64UrlEncode(input);
    const padded =
      encoded.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (encoded.length % 4)) % 4);
    expect(Buffer.from(padded, "base64").toString()).toBe(input);
  });
});

describe("encryptSecret / decryptSecret", () => {
  const keyMaterial = "test-encryption-secret-material";

  it("round-trips a secret through the current (v2) envelope", async () => {
    const plaintext = "sk-ant-secret-value-123";
    const envelope = await encryptSecret(plaintext, keyMaterial);
    expect(envelope.version).toBe(2);
    expect(envelope.salt).not.toBeNull();
    expect(envelope.ciphertext).not.toContain(plaintext);
    const decrypted = await decryptSecret(
      envelope.ciphertext,
      envelope.iv,
      keyMaterial,
      envelope.salt,
    );
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips a legacy (v1) envelope without a per-record salt", async () => {
    const plaintext = "legacy-secret";
    const envelope = await encryptSecret(plaintext, keyMaterial, 1);
    expect(envelope.version).toBe(1);
    expect(envelope.salt).toBeNull();
    const decrypted = await decryptSecret(
      envelope.ciphertext,
      envelope.iv,
      keyMaterial,
      envelope.salt,
    );
    expect(decrypted).toBe(plaintext);
  });

  it("uses a fresh random IV and salt per encryption", async () => {
    const a = await encryptSecret("same", keyMaterial);
    const b = await encryptSecret("same", keyMaterial);
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong key material", async () => {
    const envelope = await encryptSecret("secret", keyMaterial);
    await expect(
      decryptSecret(
        envelope.ciphertext,
        envelope.iv,
        "wrong-key",
        envelope.salt,
      ),
    ).rejects.toThrow();
  });

  it("throws when the encryption secret is missing", async () => {
    await expect(encryptSecret("secret", "")).rejects.toThrow(
      "missing_encryption_secret",
    );
    await expect(decryptSecret("x", "y", "")).rejects.toThrow(
      "missing_encryption_secret",
    );
  });
});
