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

  it("reports unconfigured explicitly — not just an empty list, which six different causes also produce", async () => {
    // #9834: this assertion used to be `toEqual({ keys: [], currentKeyId: null })`, and its title claimed the
    // response was "distinguishable from a key that exists". The empty half was true; the distinguishable
    // half was not -- an unset secret, malformed JSON, a non-array, and an all-typo'd list were byte-identical.
    const env = createTestEnv();
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unconfigured", keys: [], currentKeyId: null, droppedEntries: 0 });
  });

  it("fails closed to a null currentKeyId on an ambiguous rotation state rather than guessing", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([ACTIVE, { ...ACTIVE, keyId: "second0000000000" }]) });
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    const body = (await response.json()) as { keys: AnchorPublicKey[]; currentKeyId: string | null };

    expect(body.keys).toHaveLength(2); // both still published...
    expect(body.currentKeyId).toBeNull(); // ...but which one signs is genuinely ambiguous, so we do not claim
  });

  it("answers 200 (never a 500) on malformed config, and says it is MALFORMED rather than empty", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: "{not valid json" });
    const response = await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env);
    expect(response.status).toBe(200);
    // #9834: "I cannot parse what you configured" and "you configured nothing" are different operator
    // problems; serving one response for both is what made #9719's provisioning unverifiable.
    expect(await response.json()).toEqual({ status: "malformed", keys: [], currentKeyId: null, droppedEntries: 0 });
  });

  // #9834: the remaining causes, each previously indistinguishable from "unconfigured".
  it("distinguishes an all-typo'd list from an unset one", async () => {
    const typod = { keyid: ACTIVE.keyId, publicKeySpki: ACTIVE.publicKeySpki, notBefore: ACTIVE.notBefore, notAfter: null };
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([typod]) });
    const body = await (await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env)).json();
    expect(body).toMatchObject({ status: "no_valid_entries", keys: [], currentKeyId: null });
  });

  it("distinguishes an expired rotation from an ambiguous one -- both had a null currentKeyId", async () => {
    const expired = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([RETIRED]) });
    const ambiguous = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([ACTIVE, { ...ACTIVE, keyId: "second0000000000" }]) });
    const app = createApp();

    expect(await (await app.request("/v1/public/decision-ledger/anchor-key", {}, expired)).json()).toMatchObject({ status: "expired", currentKeyId: null });
    expect(await (await app.request("/v1/public/decision-ledger/anchor-key", {}, ambiguous)).json()).toMatchObject({ status: "ambiguous_rotation", currentKeyId: null });
  });

  it("surfaces a dropped entry even when the deployment is otherwise healthy", async () => {
    const typod = { keyid: "second0000000000", publicKeySpki: "eA==", notBefore: ACTIVE.notBefore, notAfter: null };
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([ACTIVE, typod]) });
    const body = await (await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env)).json();
    expect(body).toMatchObject({ status: "ok", currentKeyId: ACTIVE.keyId, droppedEntries: 1 });
  });

  it("SECURITY: a private key mis-pasted into the PUBLIC var is never echoed back", async () => {
    // The realistic operator error this diagnostic could have made catastrophic: the endpoint is
    // unauthenticated, so echoing the configured value to explain a malformed status would publish the key.
    const probe = ["-----BEGIN", " PRIVATE", " KEY-----", "MC4CAQAwBQYDK2VwBCIEIA", "-----END", " PRIVATE", " KEY-----"].join("");
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: probe });
    const raw = JSON.stringify(await (await createApp().request("/v1/public/decision-ledger/anchor-key", {}, env)).json());
    expect(raw).not.toContain("PRIVATE");
    expect(raw).not.toContain("MC4CAQAwBQYDK2VwBCIEIA");
    expect(raw).toContain("malformed");
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
