import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashToken, timingSafeEqual } from "../../src/auth/security";
import { verifyGitHubSignature, timingSafeEqualHex } from "../../src/utils/crypto";

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
    await expect(verifyGitHubSignature(body, "sha256=not-valid-hex", secret)).resolves.toBe(false);
  });

  it("rejects invalid hex operands in timingSafeEqualHex", () => {
    expect(timingSafeEqualHex("zz", "yy")).toBe(false);
    expect(timingSafeEqualHex("not-hex-a", "not-hex-b")).toBe(false);
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false);
    expect(timingSafeEqualHex("", "00")).toBe(false);
    expect(timingSafeEqualHex("00", "01")).toBe(false);
    expect(timingSafeEqualHex("00", "00")).toBe(true);
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
