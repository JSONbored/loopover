import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import type { AnchorPublicKey } from "../../src/review/ledger-anchor";

// #9270 (epic #9267): the published anchor-signing keys. The load-bearing behaviours are that the FULL
// rotation history is served (so an anchor signed under a retired key stays verifiable) and that an ambiguous
// or unconfigured state answers honestly rather than guessing at a current key.

const RETIRED: AnchorPublicKey = { keyId: "old0000000000000", publicKeySpki: "b2xka2V5", notBefore: "2025-01-01T00:00:00.000Z", notAfter: "2026-01-01T00:00:00.000Z" };
const ACTIVE: AnchorPublicKey = { keyId: "new0000000000000", publicKeySpki: "bmV3a2V5", notBefore: "2026-01-01T00:00:00.000Z", notAfter: null };

describe("GET /v1/public/decision-ledger/anchor-key (#9270)", () => {
  it("answers 200 with no Authorization header", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([ACTIVE]) });
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    expect(response.status).toBe(200);
  });

  it("serves the FULL rotation history, so an anchor signed under a retired key stays verifiable", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([RETIRED, ACTIVE]) });
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    const body = (await response.json()) as { keys: AnchorPublicKey[]; currentKeyId: string | null };

    expect(body.keys).toEqual([RETIRED, ACTIVE]); // the retired key is still published, not dropped
    expect(body.currentKeyId).toBe(ACTIVE.keyId);
  });

  it("reports an empty list and a null currentKeyId when unconfigured — 'nothing is claimed verifiable yet', distinguishable from a key that exists", async () => {
    const env = createTestEnv();
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [], currentKeyId: null });
  });

  it("fails closed to a null currentKeyId on an ambiguous rotation state rather than guessing", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([ACTIVE, { ...ACTIVE, keyId: "second0000000000" }]) });
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    const body = (await response.json()) as { keys: AnchorPublicKey[]; currentKeyId: string | null };

    expect(body.keys).toHaveLength(2); // both still published...
    expect(body.currentKeyId).toBeNull(); // ...but which one signs is genuinely ambiguous, so we do not claim
  });

  it("answers 200 with an empty list (never a 500) on malformed config", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: "{not valid json" });
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [], currentKeyId: null });
  });

  it("never serves private key material, even if it is misconfigured into the public list", async () => {
    const env = createTestEnv({
      LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([ACTIVE]),
      LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIGHAgEA\n-----END PRIVATE KEY-----",
    });
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    expect(JSON.stringify(await response.json())).not.toMatch(/PRIVATE KEY|MIGHAgEA/);
  });
});
