import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signRs256Jwt } from "../../src/utils/crypto";

async function generatePkcs8PrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

function generatePkcs1PrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("signRs256Jwt", () => {
  it("signs a JWT with PKCS#8 PEM keys and base64url segments", async () => {
    const privateKey = await generatePkcs8PrivateKeyPem();
    const token = await signRs256Jwt({ iss: "12345", iat: 1_700_000_000, exp: 1_700_000_300 }, privateKey);
    const [header, payload, signature] = token.split(".");
    expect(header).toBeTruthy();
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(signature).not.toMatch(/[+/=]/);
    expect(Buffer.from(header!, "base64url").toString()).toContain('"alg":"RS256"');
    expect(Buffer.from(payload!, "base64url").toString()).toContain('"iss":"12345"');
  });

  it("accepts legacy PKCS#1 RSA PEM keys with escaped newlines", async () => {
    const privateKey = generatePkcs1PrivateKeyPem().replace(/\n/g, "\\n");
    const token = await signRs256Jwt({ sub: "installation" }, privateKey);
    expect(token.split(".")).toHaveLength(3);
  });
});
