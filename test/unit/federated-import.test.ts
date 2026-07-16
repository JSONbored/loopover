import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { canonicalizeFederatedBundleBody, FEDERATED_BUNDLE_SCHEMA_VERSION, type FederatedSignalBundle } from "../../src/orb/federated-bundle";
import {
  importPeerBundles,
  isFederatedImportEnabled,
  verifyFederatedBundle,
  type FederatedRejection,
} from "../../src/orb/federated-import";
import type { FocusManifest } from "../../src/signals/focus-manifest";

// Fake 64-hex keys — the shape generateAnonSecret produces. Not secrets: locally-invented test fixtures.
const PEER_KEY_A = "a".repeat(64);
const PEER_KEY_B = "b".repeat(64);
const UNTRUSTED_KEY = "c".repeat(64);

const body = (over: Partial<FederatedSignalBundle> = {}) => ({
  schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION,
  instanceId: "abc123def4567890",
  generatedAt: "2026-02-01T00:00:00.000Z",
  windowDays: 90,
  decided: 40,
  mergePrecision: 0.9,
  closePrecision: 0.8,
  fpRate: 0.1,
  fnRate: 0.2,
  reversalRate: 0.05,
  cycleP50Ms: 1000,
  cycleP95Ms: 5000,
  slopRate: 0.1,
  copycatRate: 0.02,
  ...over,
});

/** Sign a body the way the export side does, so these tests pin the real cross-module contract rather than a
 *  local re-statement of it: a canonicalization change on the export side must break them. */
const signedWith = (key: string, over: Partial<FederatedSignalBundle> = {}): FederatedSignalBundle => {
  const payload = body(over);
  const signature = createHmac("sha256", key).update(canonicalizeFederatedBundleBody(payload)).digest("hex");
  return { ...payload, signature, ...(over.signature === undefined ? {} : { signature: over.signature }) };
};

const manifest = (over: Partial<FocusManifest["federatedIntelligence"]> = {}): Pick<FocusManifest, "federatedIntelligence"> => ({
  federatedIntelligence: {
    present: true,
    enabled: true,
    collectorUrl: null,
    collectorMode: null,
    peerKeys: [PEER_KEY_A],
    ...over,
  },
});

describe("isFederatedImportEnabled (#6480)", () => {
  it("is armed only when opted in AND at least one peer key is allowlisted", () => {
    expect(isFederatedImportEnabled(manifest())).toBe(true);
  });

  it("stays off when the operator opted into the export but allowlisted no peer", () => {
    // The load-bearing case: enabling the EXPORT must never, by itself, start admitting inbound data.
    expect(isFederatedImportEnabled(manifest({ peerKeys: [] }))).toBe(false);
  });

  it("stays off when not opted in, even with peer keys configured", () => {
    expect(isFederatedImportEnabled(manifest({ enabled: false }))).toBe(false);
  });

  it("stays off for an absent manifest or an absent federatedIntelligence block", () => {
    expect(isFederatedImportEnabled(null)).toBe(false);
    expect(isFederatedImportEnabled(undefined)).toBe(false);
    expect(isFederatedImportEnabled({} as Pick<FocusManifest, "federatedIntelligence">)).toBe(false);
  });
});

describe("verifyFederatedBundle (#6480)", () => {
  it("verifies a bundle signed by an allowlisted key", () => {
    expect(verifyFederatedBundle(signedWith(PEER_KEY_A), [PEER_KEY_A])).toBe(true);
  });

  it("verifies against ANY allowlisted key, not just the first", () => {
    expect(verifyFederatedBundle(signedWith(PEER_KEY_B), [PEER_KEY_A, PEER_KEY_B])).toBe(true);
  });

  it("rejects a bundle signed by a key the operator never allowlisted", () => {
    expect(verifyFederatedBundle(signedWith(UNTRUSTED_KEY), [PEER_KEY_A, PEER_KEY_B])).toBe(false);
  });

  it("rejects when the allowlist is empty", () => {
    expect(verifyFederatedBundle(signedWith(PEER_KEY_A), [])).toBe(false);
  });

  it("rejects a body tampered with after signing", () => {
    // The signature stays valid for the ORIGINAL body; flipping a field must invalidate it.
    const bundle = signedWith(PEER_KEY_A);
    expect(verifyFederatedBundle({ ...bundle, mergePrecision: 0.99 }, [PEER_KEY_A])).toBe(false);
  });

  it("rejects a non-hex or truncated signature without throwing", () => {
    expect(verifyFederatedBundle(signedWith(PEER_KEY_A, { signature: "not-hex" }), [PEER_KEY_A])).toBe(false);
    expect(verifyFederatedBundle(signedWith(PEER_KEY_A, { signature: "abcd" }), [PEER_KEY_A])).toBe(false);
    expect(verifyFederatedBundle(signedWith(PEER_KEY_A, { signature: "" }), [PEER_KEY_A])).toBe(false);
  });

  it("ignores an extra field a peer appended: it is outside the canonical key list, so it cannot alter the signed bytes", () => {
    const bundle = signedWith(PEER_KEY_A);
    expect(verifyFederatedBundle({ ...bundle, injected: "payload" } as FederatedSignalBundle, [PEER_KEY_A])).toBe(true);
  });
});

describe("importPeerBundles (#6480)", () => {
  const collect = () => {
    const seen: FederatedRejection[] = [];
    return { log: (rejection: FederatedRejection) => seen.push(rejection), seen };
  };

  it("accepts a valid bundle from an allowlisted peer", () => {
    const bundle = signedWith(PEER_KEY_A);
    const { log, seen } = collect();
    const result = importPeerBundles(manifest(), [bundle], { log });
    expect(result.accepted).toEqual([bundle]);
    expect(result.rejected).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("rejects an invalid signature and logs it", () => {
    const { log, seen } = collect();
    const result = importPeerBundles(manifest(), [signedWith(PEER_KEY_A, { signature: "f".repeat(64) })], { log });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "untrusted_or_tampered" }]);
    expect(seen).toHaveLength(1);
  });

  it("rejects a bundle from a peer outside the allowlist — the trust-gating rule", () => {
    // #6477's layer 1: a bundle that is perfectly well-formed and authentically signed is still rejected,
    // purely because the receiving operator never added this peer's key.
    const result = importPeerBundles(manifest(), [signedWith(UNTRUSTED_KEY)], { log: () => undefined });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "untrusted_or_tampered" }]);
  });

  it("never processes an inbound bundle for an opted-out instance", () => {
    const result = importPeerBundles(manifest({ enabled: false }), [signedWith(PEER_KEY_A)], { log: () => undefined });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "not_opted_in" }]);
  });

  it("rejects everything when opted in with an empty allowlist (fail closed)", () => {
    const result = importPeerBundles(manifest({ peerKeys: [] }), [signedWith(PEER_KEY_A)], { log: () => undefined });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "no_trusted_peers" }]);
  });

  it("rejects an unknown schema version rather than guessing at it", () => {
    const result = importPeerBundles(manifest(), [signedWith(PEER_KEY_A, { schemaVersion: 999 })], { log: () => undefined });
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "unsupported_schema_version" }]);
  });

  it("rejects a malformed bundle whose signed field is the wrong type", () => {
    const bundle = { ...signedWith(PEER_KEY_A), decided: "many" } as unknown as FederatedSignalBundle;
    const result = importPeerBundles(manifest(), [bundle], { log: () => undefined });
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "malformed" }]);
  });

  it("rejects a malformed bundle with a non-numeric nullable field", () => {
    const bundle = { ...signedWith(PEER_KEY_A), cycleP50Ms: "fast" } as unknown as FederatedSignalBundle;
    expect(importPeerBundles(manifest(), [bundle], { log: () => undefined }).rejected[0]!.reason).toBe("malformed");
  });

  it("accepts a bundle whose nullable fields are genuinely null (an instance under MIN_DECIDED)", () => {
    const bundle = signedWith(PEER_KEY_A, { mergePrecision: null, closePrecision: null, fpRate: null, fnRate: null, cycleP50Ms: null, cycleP95Ms: null });
    expect(importPeerBundles(manifest(), [bundle], { log: () => undefined }).accepted).toEqual([bundle]);
  });

  it("reports a null instanceId when the bundle is too malformed to carry one", () => {
    const bundle = { schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION } as unknown as FederatedSignalBundle;
    expect(importPeerBundles(manifest(), [bundle], { log: () => undefined }).rejected).toEqual([{ instanceId: null, reason: "malformed" }]);
  });

  it("partitions a mixed batch, keeping only the trusted bundles", () => {
    const good = signedWith(PEER_KEY_A, { instanceId: "1111111111111111" });
    const alsoGood = signedWith(PEER_KEY_B, { instanceId: "2222222222222222" });
    const bad = signedWith(UNTRUSTED_KEY, { instanceId: "3333333333333333" });
    const result = importPeerBundles(manifest({ peerKeys: [PEER_KEY_A, PEER_KEY_B] }), [good, bad, alsoGood], { log: () => undefined });
    expect(result.accepted).toEqual([good, alsoGood]);
    expect(result.rejected).toEqual([{ instanceId: "3333333333333333", reason: "untrusted_or_tampered" }]);
  });

  it("handles an empty batch", () => {
    expect(importPeerBundles(manifest(), [])).toEqual({ accepted: [], rejected: [] });
  });

  it("warns on the console by default, so a rejection is never silently dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    importPeerBundles(manifest(), [signedWith(UNTRUSTED_KEY)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("untrusted_or_tampered");
    warn.mockRestore();
  });

  it("never logs a peer key or bundle contents", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    importPeerBundles(manifest(), [signedWith(UNTRUSTED_KEY)]);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).not.toContain(PEER_KEY_A);
    expect(line).not.toContain("0.9");
    warn.mockRestore();
  });

  it("treats an absent manifest as opted out", () => {
    expect(importPeerBundles(null, [signedWith(PEER_KEY_A)], { log: () => undefined }).rejected[0]!.reason).toBe("not_opted_in");
    expect(importPeerBundles(undefined, [], { log: () => undefined })).toEqual({ accepted: [], rejected: [] });
  });
});
