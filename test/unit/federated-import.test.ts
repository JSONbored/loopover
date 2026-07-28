import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { canonicalizeFederatedBundleBody, FEDERATED_BUNDLE_SCHEMA_VERSION, type FederatedSignalBundle } from "../../src/orb/federated-bundle";
import {
  applyFederatedPeerWatermarks,
  importPeerBundles,
  isFederatedImportEnabled,
  matchingFederatedKey,
  verifyFederatedBundle,
  type FederatedRejection,
  MAX_INSTANCE_ID_CHARS,
} from "../../src/orb/federated-import";
import { createTestEnv, type TestD1Database } from "../helpers/d1";
import type { FocusManifest } from "../../src/signals/focus-manifest";

// Fake 64-hex keys — the shape generateAnonSecret produces. Not secrets: locally-invented test fixtures.
const PEER_KEY_A = "a".repeat(64);
const PEER_KEY_B = "b".repeat(64);
const UNTRUSTED_KEY = "c".repeat(64);

// Computed at call time (not a fixed literal) so every test bundle is fresh relative to whatever `now`
// importPeerBundles defaults to (real Date.now()) — the freshness gate (#9148) would otherwise reject a
// fixed past date as the test suite ages. Tests that specifically exercise staleness pass an explicit
// `generatedAt` (and/or an explicit `now` opt) instead of relying on this default.
const FRESH_GENERATED_AT = () => new Date(Date.now() - 60_000).toISOString();

const body = (over: Partial<FederatedSignalBundle> = {}) => ({
  schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION,
  instanceId: "abc123def4567890",
  generatedAt: FRESH_GENERATED_AT(),
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

  // #9490: instanceIds are persisted into the single system_flags peer-state blob, and nothing bounded their
  // length -- 3-4 bundles carrying ~600 KB ids pushed that blob past D1's ~2 MB value limit, the state write
  // failed silently, and replay/rollback watermarks stopped persisting for EVERY peer.
  it("REGRESSION (#9490): rejects an oversized instanceId as malformed — it would poison the shared peer-state blob", () => {
    const oversized = signedWith(PEER_KEY_A, { instanceId: "x".repeat(MAX_INSTANCE_ID_CHARS + 1) });
    const result = importPeerBundles(manifest(), [oversized], { log: () => undefined });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ instanceId: "x".repeat(MAX_INSTANCE_ID_CHARS + 1), reason: "malformed" }]);
  });

  it("INVARIANT (#9490): an instanceId at exactly the cap still verifies, and an empty one is malformed", () => {
    const atCap = signedWith(PEER_KEY_A, { instanceId: "x".repeat(MAX_INSTANCE_ID_CHARS) });
    expect(importPeerBundles(manifest(), [atCap], { log: () => undefined }).accepted).toEqual([atCap]);
    const empty = signedWith(PEER_KEY_A, { instanceId: "" });
    expect(importPeerBundles(manifest(), [empty], { log: () => undefined }).rejected).toEqual([{ instanceId: "", reason: "malformed" }]);
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

  it("labels an unreadable instance handle as unknown rather than logging 'null'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    importPeerBundles(manifest(), [{ schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION } as unknown as FederatedSignalBundle]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("instance=unknown");
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

  it("#9148: keeps only the LAST bundle per instanceId within a batch (Sybil dedup)", () => {
    const first = signedWith(PEER_KEY_A, { mergePrecision: 0.5 });
    const second = signedWith(PEER_KEY_A, { mergePrecision: 0.99 }); // same instanceId, re-signed
    const result = importPeerBundles(manifest(), [first, second], { log: () => undefined });
    expect(result.accepted).toEqual([second]);
    expect(result.rejected).toEqual([]); // the superseded duplicate is silently dropped, not logged as a rejection
  });

  it("#9148: rejects every numeric field outside its valid range", () => {
    const cases: Partial<FederatedSignalBundle>[] = [
      { mergePrecision: -0.01 },
      { mergePrecision: 1.01 },
      { closePrecision: -1 },
      { fpRate: 2 },
      { fnRate: -0.5 },
      { reversalRate: 1.5 },
      { slopRate: -0.1 },
      { copycatRate: 1.5 },
      { decided: -1 },
      { windowDays: 0 },
      { windowDays: -90 },
      { cycleP50Ms: -1 },
      { cycleP95Ms: -1 },
      { cycleP50Ms: 5000, cycleP95Ms: 1000 }, // p50 can never exceed p95 of the same sample
    ];
    for (const over of cases) {
      const result = importPeerBundles(manifest(), [signedWith(PEER_KEY_A, over)], { log: () => undefined });
      expect(result.rejected[0]?.reason, JSON.stringify(over)).toBe("out_of_range");
    }
  });

  it("#9148: accepts the boundary values 0 and 1 for a unit-rate field (inclusive range)", () => {
    const zero = importPeerBundles(manifest(), [signedWith(PEER_KEY_A, { instanceId: "i-zero", mergePrecision: 0, fpRate: 0 })], { log: () => undefined });
    expect(zero.accepted).toHaveLength(1);
    const one = importPeerBundles(manifest(), [signedWith(PEER_KEY_A, { instanceId: "i-one", mergePrecision: 1, fpRate: 1 })], { log: () => undefined });
    expect(one.accepted).toHaveLength(1);
  });

  it("#9148: rejects a windowDays that does not match the local instance's own resolved window", () => {
    const result = importPeerBundles(manifest(), [signedWith(PEER_KEY_A, { windowDays: 30 })], { log: () => undefined }, );
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "window_mismatch" }]);
  });

  it("#9148: honors an explicit localWindowDays override instead of the DEFAULT_WINDOW_DAYS default", () => {
    const bundle = signedWith(PEER_KEY_A, { windowDays: 30 });
    const result = importPeerBundles(manifest(), [bundle], { log: () => undefined, localWindowDays: 30 });
    expect(result.accepted).toEqual([bundle]);
  });

  it("#9148: rejects an unparseable generatedAt", () => {
    const result = importPeerBundles(manifest(), [signedWith(PEER_KEY_A, { generatedAt: "not-a-date" })], { log: () => undefined });
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "stale_or_future" }]);
  });

  it("#9148: rejects a bundle older than the max age, and one too far in the future — accepts one just inside each edge", () => {
    const now = Date.parse("2026-03-01T00:00:00.000Z");
    const eightDaysStale = signedWith(PEER_KEY_A, { generatedAt: "2026-02-21T00:00:00.000Z" }); // > 7 days old
    const sixDaysStale = signedWith(PEER_KEY_A, { generatedAt: "2026-02-23T00:00:00.000Z" }); // < 7 days old
    const tenMinutesFuture = signedWith(PEER_KEY_A, { generatedAt: "2026-03-01T00:10:00.000Z" }); // > 5 min skew
    const oneMinuteFuture = signedWith(PEER_KEY_A, { generatedAt: "2026-03-01T00:01:00.000Z" }); // < 5 min skew
    expect(importPeerBundles(manifest(), [eightDaysStale], { log: () => undefined, now }).rejected[0]?.reason).toBe("stale_or_future");
    expect(importPeerBundles(manifest(), [sixDaysStale], { log: () => undefined, now }).accepted).toEqual([sixDaysStale]);
    expect(importPeerBundles(manifest(), [tenMinutesFuture], { log: () => undefined, now }).rejected[0]?.reason).toBe("stale_or_future");
    expect(importPeerBundles(manifest(), [oneMinuteFuture], { log: () => undefined, now }).accepted).toEqual([oneMinuteFuture]);
  });

  it("#9148: enforces MIN_DECIDED receiver-side, regardless of what the sender claims", () => {
    // A hostile/buggy peer self-reporting a real mergePrecision despite decided being below MIN_DECIDED (5).
    const underclaimed = signedWith(PEER_KEY_A, { decided: 3, mergePrecision: 1.0 });
    const result = importPeerBundles(manifest(), [underclaimed], { log: () => undefined });
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "below_min_decided" }]);
  });

  it("#9148: accepts a decided count exactly at MIN_DECIDED", () => {
    const bundle = signedWith(PEER_KEY_A, { decided: 5 });
    expect(importPeerBundles(manifest(), [bundle], { log: () => undefined }).accepted).toEqual([bundle]);
  });
});

describe("matchingFederatedKey (#9148)", () => {
  it("returns the specific key that verified, not just a boolean", () => {
    expect(matchingFederatedKey(signedWith(PEER_KEY_B), [PEER_KEY_A, PEER_KEY_B])).toBe(PEER_KEY_B);
  });

  it("returns null when no allowlisted key verifies", () => {
    expect(matchingFederatedKey(signedWith(UNTRUSTED_KEY), [PEER_KEY_A, PEER_KEY_B])).toBeNull();
  });
});

describe("applyFederatedPeerWatermarks (#9148, the persisted gates)", () => {
  const env = () => createTestEnv();
  const db = (e: Env) => e.DB as unknown as TestD1Database;
  const okResult = (bundles: FederatedSignalBundle[]): { accepted: FederatedSignalBundle[]; rejected: [] } => ({ accepted: bundles, rejected: [] });

  it("admits a brand-new instanceId and persists its watermark", async () => {
    const e = env();
    const bundle = signedWith(PEER_KEY_A);
    const result = await applyFederatedPeerWatermarks(e.DB, okResult([bundle]), [PEER_KEY_A], { now: Date.parse(bundle.generatedAt) });
    expect(result.accepted).toEqual([bundle]);
    expect(result.rejected).toEqual([]);
    const row = await db(e).prepare("SELECT value FROM system_flags WHERE key = 'orb:federated_peer_state'").first<{ value: string }>();
    expect(JSON.parse(row?.value ?? "{}")).toHaveProperty(bundle.instanceId);
  });

  it("admits a newer bundle for an already-known instanceId, refreshing the watermark", async () => {
    const e = env();
    const first = signedWith(PEER_KEY_A, { generatedAt: "2026-03-01T00:00:00.000Z" });
    await applyFederatedPeerWatermarks(e.DB, okResult([first]), [PEER_KEY_A], { now: Date.parse(first.generatedAt) });
    const second = signedWith(PEER_KEY_A, { generatedAt: "2026-03-02T00:00:00.000Z" });
    const result = await applyFederatedPeerWatermarks(e.DB, okResult([second]), [PEER_KEY_A], { now: Date.parse(second.generatedAt) });
    expect(result.accepted).toEqual([second]);
  });

  it("rejects a replay: the same or an older generatedAt for an instanceId already on record", async () => {
    const e = env();
    const fresh = signedWith(PEER_KEY_A, { generatedAt: "2026-03-05T00:00:00.000Z" });
    await applyFederatedPeerWatermarks(e.DB, okResult([fresh]), [PEER_KEY_A], { now: Date.parse(fresh.generatedAt) });
    const replay = signedWith(PEER_KEY_A, { generatedAt: "2026-03-01T00:00:00.000Z" }); // same instanceId, OLDER generatedAt
    const result = await applyFederatedPeerWatermarks(e.DB, okResult([replay]), [PEER_KEY_A], { now: Date.parse(fresh.generatedAt) });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ instanceId: "abc123def4567890", reason: "replayed_or_rollback" }]);
  });

  it("caps a single key at MAX_INSTANCES_PER_KEY distinct instanceIds, admitting the first N and rejecting the rest", async () => {
    const e = env();
    let accepted: FederatedSignalBundle[] = [];
    let lastRejectedReason: string | undefined;
    for (let i = 0; i < 11; i += 1) {
      const bundle = signedWith(PEER_KEY_A, { instanceId: `sybil-instance-${i}` });
      const result = await applyFederatedPeerWatermarks(e.DB, okResult([bundle]), [PEER_KEY_A], { now: Date.parse(bundle.generatedAt) });
      accepted = accepted.concat(result.accepted);
      if (result.rejected.length > 0) lastRejectedReason = result.rejected[0]?.reason;
    }
    expect(accepted).toHaveLength(10); // MAX_INSTANCES_PER_KEY
    expect(lastRejectedReason).toBe("sybil_cap_exceeded");
  });

  it("a DIFFERENT verifying key gets its own independent cap", async () => {
    const e = env();
    for (let i = 0; i < 10; i += 1) {
      const bundle = signedWith(PEER_KEY_A, { instanceId: `key-a-instance-${i}` });
      await applyFederatedPeerWatermarks(e.DB, okResult([bundle]), [PEER_KEY_A, PEER_KEY_B], { now: Date.parse(bundle.generatedAt) });
    }
    // PEER_KEY_A is now at its cap, but PEER_KEY_B has contributed nothing yet — a new instance under B must
    // still be admitted, proving the cap is scoped per-key rather than a single shared global counter.
    const underB = signedWith(PEER_KEY_B, { instanceId: "key-b-instance-0" });
    const result = await applyFederatedPeerWatermarks(e.DB, okResult([underB]), [PEER_KEY_A, PEER_KEY_B], { now: Date.parse(underB.generatedAt) });
    expect(result.accepted).toEqual([underB]);
  });

  it("prunes a peer-state entry that hasn't been refreshed in a very long time, freeing its key's cap slot", async () => {
    const e = env();
    const veryOldEntry = { "stale-instance": { keyFingerprint: "x".repeat(64), lastGeneratedAtMs: 0, lastSeenAtMs: 0, firstSeenAtMs: 0 } };
    await db(e).prepare("INSERT INTO system_flags (key, value, updated_at) VALUES ('orb:federated_peer_state', ?, CURRENT_TIMESTAMP)").bind(JSON.stringify(veryOldEntry)).run();
    const bundle = signedWith(PEER_KEY_A, { instanceId: "fresh-instance" });
    const farFuture = Date.parse(bundle.generatedAt) + 500 * 86_400_000; // well past PEER_STATE_PRUNE_AFTER_MS
    await applyFederatedPeerWatermarks(e.DB, okResult([bundle]), [PEER_KEY_A], { now: farFuture });
    const row = await db(e).prepare("SELECT value FROM system_flags WHERE key = 'orb:federated_peer_state'").first<{ value: string }>();
    expect(JSON.parse(row?.value ?? "{}")).not.toHaveProperty("stale-instance"); // pruned, not just superseded
  });

  it("degrades to treating every instanceId as new when the persisted state is corrupt JSON", async () => {
    const e = env();
    await db(e).prepare("INSERT INTO system_flags (key, value, updated_at) VALUES ('orb:federated_peer_state', 'not-json', CURRENT_TIMESTAMP)").run();
    const bundle = signedWith(PEER_KEY_A);
    const result = await applyFederatedPeerWatermarks(e.DB, okResult([bundle]), [PEER_KEY_A], { now: Date.parse(bundle.generatedAt) });
    expect(result.accepted).toEqual([bundle]); // fail-safe: corrupt cache never blocks a legitimate peer
  });

  // #9490: an instanceId is BOUND to the first key that verified it. Without this, hostile-but-allowlisted
  // peer B could claim honest peer A's id -- shadow A's bundle in-batch, overwrite the watermark entry's
  // keyFingerprint, then ratchet lastGeneratedAtMs so A's genuine bundles reject as replayed_or_rollback
  // forever: targeted suppression plus stat replacement, and a bypass of B's own Sybil cap (only NEW ids
  // count against it). Squarely inside #9148's declared threat model.
  it("REGRESSION (#9490): a second allowlisted key cannot take over an instanceId bound to the first key", async () => {
    const e = env();
    const honest = signedWith(PEER_KEY_A, { instanceId: "shared-target-id", generatedAt: "2026-03-01T00:00:00.000Z" });
    await applyFederatedPeerWatermarks(e.DB, okResult([honest]), [PEER_KEY_A, PEER_KEY_B], { now: Date.parse(honest.generatedAt) });

    // B verifies under its OWN (allowlisted) key but claims A's id, with a newer generatedAt -- the ratchet.
    const takeover = signedWith(PEER_KEY_B, { instanceId: "shared-target-id", generatedAt: "2026-03-09T00:00:00.000Z" });
    const result = await applyFederatedPeerWatermarks(e.DB, okResult([takeover]), [PEER_KEY_A, PEER_KEY_B], { now: Date.parse(takeover.generatedAt) });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ instanceId: "shared-target-id", reason: "instance_key_conflict" }]);

    // The decisive invariant: A's NEXT genuine bundle still lands -- neither its watermark nor its key
    // binding was moved by the attempt.
    const next = signedWith(PEER_KEY_A, { instanceId: "shared-target-id", generatedAt: "2026-03-02T00:00:00.000Z" });
    const after = await applyFederatedPeerWatermarks(e.DB, okResult([next]), [PEER_KEY_A, PEER_KEY_B], { now: Date.parse(next.generatedAt) });
    expect(after.accepted).toEqual([next]);
  });

  it("INVARIANT (#9490): the takeover rejection does not free the id — repeated attempts keep failing without perturbing state", async () => {
    const e = env();
    const honest = signedWith(PEER_KEY_A, { instanceId: "sticky-id", generatedAt: "2026-03-01T00:00:00.000Z" });
    await applyFederatedPeerWatermarks(e.DB, okResult([honest]), [PEER_KEY_A, PEER_KEY_B], { now: Date.parse(honest.generatedAt) });
    for (const attemptAt of ["2026-03-03T00:00:00.000Z", "2026-03-04T00:00:00.000Z"]) {
      const attempt = signedWith(PEER_KEY_B, { instanceId: "sticky-id", generatedAt: attemptAt });
      const result = await applyFederatedPeerWatermarks(e.DB, okResult([attempt]), [PEER_KEY_A, PEER_KEY_B], { now: Date.parse(attemptAt) });
      expect(result.rejected[0]?.reason).toBe("instance_key_conflict");
    }
  });

  it("REGRESSION (#9490): a failing peer-state write is LOUD (error-level structured log) while still failing open", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const e = env();
      // Make ONLY the system_flags write fail; the read path (SELECT) must still work.
      const realDb = e.DB;
      const failingDb = {
        prepare: (sql: string) => {
          const statement = realDb.prepare(sql);
          if (/^INSERT OR REPLACE INTO system_flags/i.test(sql)) {
            return { bind: () => ({ run: () => Promise.reject(new Error("value exceeds maximum size")) }) };
          }
          return statement;
        },
      } as unknown as D1Database;
      const bundle = signedWith(PEER_KEY_A);

      const result = await applyFederatedPeerWatermarks(failingDb, okResult([bundle]), [PEER_KEY_A], { now: Date.parse(bundle.generatedAt) });

      expect(result.accepted).toEqual([bundle]); // fail-open: the sync tick is never failed by the write
      expect(
        errorSpy.mock.calls.some((call) => {
          const line = String(call[0]);
          return line.includes("federated_peer_state_write_failed") && line.includes("value exceeds maximum size");
        }),
      ).toBe(true);
      // A non-Error rejection takes the String() arm rather than crashing the logger.
      const failingDb2 = {
        prepare: (sql: string) =>
          /^INSERT OR REPLACE INTO system_flags/i.test(sql)
            ? { bind: () => ({ run: () => Promise.reject("plain string failure") }) }
            : realDb.prepare(sql),
      } as unknown as D1Database;
      const bundle2 = signedWith(PEER_KEY_A, { instanceId: "second-instance" });
      await applyFederatedPeerWatermarks(failingDb2, okResult([bundle2]), [PEER_KEY_A], { now: Date.parse(bundle2.generatedAt) });
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("plain string failure"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("passes through prior rejections untouched alongside its own", async () => {
    const e = env();
    const priorRejection: FederatedRejection = { instanceId: "already-rejected", reason: "malformed" };
    const bundle = signedWith(PEER_KEY_A);
    const result = await applyFederatedPeerWatermarks(e.DB, { accepted: [bundle], rejected: [priorRejection] }, [PEER_KEY_A], { now: Date.parse(bundle.generatedAt) });
    expect(result.rejected).toContainEqual(priorRejection);
    expect(result.accepted).toEqual([bundle]);
  });
});
