import { afterEach, describe, expect, it, vi } from "vitest";
import { initiateAprRepoTransfer } from "../../src/orb/apr-repo-transfer";
import { createTestEnv } from "../helpers/d1";

// Mint a real RSA private key so createOrbInstallationToken's JWT signing (RS256) succeeds — the transfer flow
// mints an installation token first, exactly like the rest of src/orb/app-auth.ts.
async function pkcs8Pem(): Promise<string> {
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
  const b64 = Buffer.from(
    (await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer,
  )
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

const orbEnv = async (): Promise<Env> =>
  createTestEnv({
    ORB_GITHUB_APP_ID: "4139483",
    ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem(),
  });

/** Stub fetch so the installation-token mint always succeeds and the transfer endpoint responds however a test
 *  asks. Records the transfer request so a test can assert the endpoint, method, and `new_owner` body. */
function stubTransfer(transfer: () => Response): {
  calls: Array<{
    url: string;
    method?: string | undefined;
    body?: string | undefined;
  }>;
} {
  const calls: Array<{
    url: string;
    method?: string | undefined;
    body?: string | undefined;
  }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return Response.json({
          token: "ghs_transfer",
          expires_at: "2026-06-25T07:00:00Z",
          permissions: { administration: "write" },
        });
      calls.push({
        url,
        method: init?.method,
        body: init?.body as string | undefined,
      });
      return transfer();
    },
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("initiateAprRepoTransfer", () => {
  it("initiates the transfer (202) and reports initiated — never complete", async () => {
    // GitHub returns 202 Accepted with the still-pending repo object; the transfer is NOT yet complete.
    const { calls } = stubTransfer(
      () =>
        new Response(JSON.stringify({ full_name: "loopover-org/acme-app" }), {
          status: 202,
        }),
    );

    const result = await initiateAprRepoTransfer(
      await orbEnv(),
      42,
      "loopover-org/acme-app",
      "customer-login",
    );

    expect(result).toEqual({
      initiated: true,
      status: 202,
      repo: "loopover-org/acme-app",
      newOwner: "customer-login",
    });
    // Hit the documented transfer endpoint with POST and the target login as `new_owner`.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/loopover-org/acme-app/transfer",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      new_owner: "customer-login",
    });
  });

  it("rejects a malformed repoFullName locally (status 0) without minting a token or hitting GitHub", async () => {
    // A `?`-carrying value would redirect the POST to a different endpoint, so it's refused before any network I/O.
    const { calls } = stubTransfer(() => new Response(null, { status: 202 }));

    const result = await initiateAprRepoTransfer(
      await orbEnv(),
      42,
      "loopover-org/acme-app?ref=evil",
      "customer-login",
    );

    expect(result).toEqual({
      initiated: false,
      status: 0,
      error: "invalid repoFullName: loopover-org/acme-app?ref=evil",
    });
    // No token mint, no transfer POST — nothing reached the stubbed fetch at all.
    expect(calls).toHaveLength(0);
  });

  it("returns initiated:false with the status + message when the target account doesn't exist (404)", async () => {
    stubTransfer(
      () =>
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );

    const result = await initiateAprRepoTransfer(
      await orbEnv(),
      42,
      "loopover-org/acme-app",
      "ghost-account",
    );

    // A GitHub-side rejection is returned, not thrown — no unhandled exception.
    expect(result).toEqual({
      initiated: false,
      status: 404,
      error: JSON.stringify({ message: "Not Found" }),
    });
  });

  it("returns initiated:false when the caller lacks admin access (403), truncating a long error body", async () => {
    const longBody = "x".repeat(500);
    stubTransfer(() => new Response(longBody, { status: 403 }));

    const result = await initiateAprRepoTransfer(
      await orbEnv(),
      42,
      "loopover-org/acme-app",
      "customer-login",
    );

    expect(result.initiated).toBe(false);
    expect(result).toMatchObject({ initiated: false, status: 403 });
    // Error body is truncated to keep the result diagnostic without unbounded growth.
    if (!result.initiated) expect(result.error).toBe("x".repeat(200));
  });
});
