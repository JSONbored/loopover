import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashToken, timingSafeEqual } from "../../src/auth/security";
import { base64UrlEncode, sha256Hex, timingSafeEqualHex, verifyGitHubSignature } from "../../src/utils/crypto";

describe("crypto helpers", () => {
  it("hashes input with sha256Hex", async () => {
    const digest = await sha256Hex("gittensory");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await sha256Hex("gittensory"));
    expect(digest).not.toBe(await sha256Hex("gittensory-x"));
  });

  it("compares hex strings in constant time and rejects malformed input", () => {
    expect(timingSafeEqualHex("ab12", "ab12")).toBe(true);
    expect(timingSafeEqualHex("ab12", "ab13")).toBe(false);
    expect(timingSafeEqualHex("ab12", "ab1234")).toBe(false);
    expect(timingSafeEqualHex("zz", "00")).toBe(false);
    expect(timingSafeEqualHex("abc", "def")).toBe(false);
    expect(timingSafeEqualHex("", "00")).toBe(false);
  });

  it("base64url-encodes strings and byte arrays without padding", () => {
    expect(base64UrlEncode("hello")).toBe("aGVsbG8");
    expect(base64UrlEncode(new Uint8Array([255, 254]))).toBe("__4");
    expect(base64UrlEncode("subjects?_d")).toBe(base64UrlEncode("subjects?_d"));
  });
});

describe("webhook signature verification", () => {
  it("accepts valid GitHub HMAC signatures and rejects tampering", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "opened" });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const signature = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    await expect(verifyGitHubSignature(body, `sha256=${signature}`, secret)).resolves.toBe(true);
    await expect(verifyGitHubSignature(`${body}x`, `sha256=${signature}`, secret)).resolves.toBe(false);
    await expect(verifyGitHubSignature(body, null, secret)).resolves.toBe(false);
    await expect(verifyGitHubSignature(body, "bad-prefix", secret)).resolves.toBe(false);
    await expect(verifyGitHubSignature(body, `sha256=${signature}`, "")).resolves.toBe(false);
    await expect(verifyGitHubSignature(body, "sha256=abc", secret)).resolves.toBe(false);
    await expect(verifyGitHubSignature(body, "sha256=zz", secret)).resolves.toBe(false);
  });

  it("uses timing-safe token comparisons and one-way token hashes", async () => {
    await expect(timingSafeEqual("token-a", "token-a")).resolves.toBe(true);
    await expect(timingSafeEqual("token-a", "token-b")).resolves.toBe(false);
    await expect(timingSafeEqual("token-a", undefined)).resolves.toBe(false);
    await expect(hashToken("token-a")).resolves.toMatch(/^[0-9a-f]{64}$/);

    const token = createOpaqueToken();
    expect(token).toMatch(/^gts_[0-9a-f]{64}$/);
    expect(token).not.toContain("token-a");
  });
});
