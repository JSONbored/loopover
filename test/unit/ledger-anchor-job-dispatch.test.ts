import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";
import { processJob } from "../../src/queue/job-dispatch";
import { buildDecisionRecord, contentDigest, persistDecisionRecord } from "../../src/review/decision-record";
import { loadPublicLedgerAnchors } from "../../src/review/ledger-anchor-persistence";
import { computeAnchorKeyId } from "../../src/review/ledger-anchor";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function generateAnchorKeypair(): Promise<{ privateKeyPem: string; publicKeySpki: string; keyId: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  const publicKeySpki = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer));
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${(pkcs8.match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----`;
  return { privateKeyPem, publicKeySpki, keyId: await computeAnchorKeyId(publicKeySpki) };
}

// #9274 (epic #9267): the real dispatch wiring in job-dispatch.ts -- constructing the git-anchoring callback
// (or not) around the shared runScheduledLedgerAnchor logic, which is otherwise exhaustively unit-tested
// with dependency injection in ledger-anchor-scheduler.test.ts. This file exercises the actual "type:
// anchor-decision-ledger" case end to end, including a REAL installation-token mint for the git path.

async function seedOneDecision(env: Env): Promise<void> {
  const { record, recordDigest } = await buildDecisionRecord({
    repoFullName: "acme/widgets",
    pullNumber: 1,
    headSha: "abc1",
    baseSha: null,
    action: "merge",
    reasonCode: "gate_clean",
    configDigest: await contentDigest({ gatePack: "oss-anti-slop" }),
    gatePack: "oss-anti-slop",
    ciState: null,
    modelIds: null,
    promptDigest: null,
    aiConfidence: null,
    salvageability: null,
  });
  await persistDecisionRecord(env, record, recordDigest);
}

describe("processJob('anchor-decision-ledger') (#9274)", () => {
  it("resolves cleanly with git anchoring skipped when owner/repo/installation are unconfigured", async () => {
    const env = createTestEnv();
    await seedOneDecision(env);
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ x: { logIndex: 1, uuid: "u", logId: { keyId: "k" } } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(processJob(env, { type: "anchor-decision-ledger", requestedBy: "test", isHourly: true })).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
    // No signing key configured in this env either -> nothing was ever attempted (honest degrade), but the
    // job itself must not throw regardless.
    const { anchors } = await loadPublicLedgerAnchors(env, { backend: "git" });
    expect(anchors).toEqual([]);
  });

  it("mints a REAL installation token and drives submitToGitAnchor's real Contents API call sequence when fully configured", async () => {
    const { privateKeyPem, publicKeySpki, keyId } = await generateAnchorKeypair();
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme",
      LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors",
      LOOPOVER_LEDGER_ANCHOR_GIT_INSTALLATION_ID: "123",
      LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: privateKeyPem,
      LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([{ keyId, publicKeySpki, notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }]),
    });
    await seedOneDecision(env);

    const contentsCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
        if (url.includes("/contents/")) {
          const method = String(init?.method ?? "GET");
          contentsCalls.push(method);
          if (method === "GET") return new Response("Not Found", { status: 404 }); // first anchor ever
          return Response.json({ commit: { sha: "committed-sha" } });
        }
        if (url.includes("rekor.sigstore.dev")) return new Response(JSON.stringify({ x: { logIndex: 1, uuid: "u", logId: { keyId: "k" } } }), { status: 201 });
        return new Response("unexpected", { status: 500 });
      }),
    );
    try {
      await expect(processJob(env, { type: "anchor-decision-ledger", requestedBy: "test", isHourly: true })).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }

    // Proves the DISPATCH wiring itself: a real installation-token mint, real makeInstallationOctokit
    // construction, and the real submitToGitAnchor call sequence (GET then PUT against Contents API) --
    // submitToGitAnchor's own internal logic is exhaustively covered with injected octokit in
    // ledger-anchor-git.test.ts; this test's job is only to prove nothing is misconfigured at the boundary
    // where job-dispatch.ts wires token-minting around it.
    expect(contentsCalls).toEqual(["GET", "PUT"]);

    const { anchors } = await loadPublicLedgerAnchors(env, { backend: "git" });
    expect(anchors[0]).toMatchObject({ status: "ok", backendRef: { sha: "committed-sha" } });
  });
});
