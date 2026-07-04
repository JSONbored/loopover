import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrbAppJwt, createOrbInstallationToken, listOrbAppInstallations } from "../../src/orb/app-auth";
import { backfillOrbInstallations } from "../../src/orb/installations";
import { createTestEnv, type TestD1Database } from "../helpers/d1";

async function pkcs8Pem(): Promise<string> {
  const key = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const b64 = Buffer.from((await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}
const orbEnv = (over: Partial<Env> = {}): Env => createTestEnv({ ORB_GITHUB_APP_ID: "4139483", ...over });

afterEach(() => vi.unstubAllGlobals());

describe("createOrbAppJwt", () => {
  it("throws when the App id or private key is missing", async () => {
    await expect(createOrbAppJwt(createTestEnv())).rejects.toThrow(/not configured/); // no id (first ||)
    await expect(createOrbAppJwt(orbEnv())).rejects.toThrow(/not configured/); // id present, no key (second ||)
  });

  it("signs a three-part JWT with valid credentials", async () => {
    const jwt = await createOrbAppJwt(orbEnv({ ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem() }));
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("listOrbAppInstallations", () => {
  it("walks pages and maps installs (missing account / id tolerated)", async () => {
    const env = orbEnv({ ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem() });
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, account: { login: "acme", type: "Organization", id: 20 }, repository_selection: "all" }));
    const page2 = [{ id: 101, account: { login: "bob", type: "User", id: 21 }, repository_selection: "selected" }, { account: { login: "no-id" } }, { id: 102 }];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL) => Response.json(String(url).includes("&page=1") ? page1 : page2));
    const installs = await listOrbAppInstallations(env);
    expect(installs).toHaveLength(102); // 100 (full page → continue) + 101 + 102; the no-id row is skipped
    expect(installs.at(-1)).toEqual({ id: 102, accountLogin: null, accountType: null, accountId: null, repositorySelection: null });
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    await expect(listOrbAppInstallations(orbEnv({ ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem() }))).rejects.toThrow(/Failed to list/);
  });
});

describe("createOrbInstallationToken", () => {
  const env = async (): Promise<Env> => orbEnv({ ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem() });

  it("returns the minted token + GitHub's real expiry (empty only when absent)", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ token: "ghs_minted", expires_at: "2026-06-25T07:00:00Z", permissions: { contents: "write" } }));
    expect(await createOrbInstallationToken(await env(), 42)).toEqual({ token: "ghs_minted", expiresAt: "2026-06-25T07:00:00Z", permissions: { contents: "write" } });
    vi.stubGlobal("fetch", async () => Response.json({ token: "ghs_noexp" }));
    expect(await createOrbInstallationToken(await env(), 42)).toMatchObject({ expiresAt: "", permissions: {} });
  });

  it("throws on a non-ok response or a missing token", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
    await expect(createOrbInstallationToken(await env(), 42)).rejects.toThrow(/Failed to create/);
    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(createOrbInstallationToken(await env(), 42)).rejects.toThrow(/did not include a token/);
  });
});

describe("backfillOrbInstallations", () => {
  it("upserts installs from GitHub WITHOUT touching registered", async () => {
    const env = orbEnv({ ORB_GITHUB_APP_PRIVATE_KEY: await pkcs8Pem() });
    await (env.DB as unknown as TestD1Database).prepare("INSERT INTO orb_github_installations (installation_id, registered) VALUES (5, 1)").run(); // already opted in
    vi.stubGlobal("fetch", async () =>
      Response.json([
        { id: 5, account: { login: "acme", type: "Organization", id: 20 }, repository_selection: "all" },
        { id: 6, account: { login: "bob", type: "User", id: 21 }, repository_selection: "selected" },
      ]),
    );
    expect(await backfillOrbInstallations(env)).toEqual({ backfilled: 2 });
    const rows = await (env.DB as unknown as TestD1Database)
      .prepare("SELECT installation_id, account_login, account_id, registered FROM orb_github_installations ORDER BY installation_id")
      .all<{ installation_id: number; account_login: string; account_id: number; registered: number }>();
    expect(rows.results).toEqual([
      { installation_id: 5, account_login: "acme", account_id: 20, registered: 1 }, // stayed registered (backfill never re-trusts/untrusts)
      { installation_id: 6, account_login: "bob", account_id: 21, registered: 0 }, // new → default opt-out
    ]);
  });
});
