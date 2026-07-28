// LoopOver federated fleet intelligence (#1970) — OPT-IN, peer bundle IMPORT + trust-gating (#6480).
//
// This is the RECEIVING side: it decides whether a bundle pulled by the transport client
// (src/orb/federated-collector.ts, #6479) may be folded into local calibration or the peer-median benchmark
// (#6481) at all. The export side is #6478 (src/orb/federated-bundle.ts).
//
// The trust model is #6477's DESIGN DECISION. Its poisoning-resistance layers, and where each one lives:
//   1. ALLOWLIST — only a peer whose verification key the operator explicitly added to
//      `federatedIntelligence.peerKeys` is ever considered. Mirrors MCP_READ_REPO_ALLOWLIST's posture:
//      explicit operator config, fail closed when unset, never auto-discovery and never a PKI.
//   2. MEDIAN, NOT MEAN — a bounded number of outliers cannot drag a median arbitrarily, unlike a mean. That
//      layer needs no code here: the fleet aggregation this feeds already medians (src/orb/analytics.ts:92),
//      so it holds by construction. Re-implementing it in this module would fork the definition #6481's
//      comparison depends on.
//   3. PER-KEY SYBIL CAP + PERSISTED WATERMARK (#9148) — layer 1 alone is NOT self-limiting for peers, only
//      for KEYS: nothing previously bound an `instanceId` to a key, so one allowlisted key could sign an
//      unbounded number of distinct fabricated `instanceId`s and, since `accepted` had no per-instance dedup
//      either, own the entire median outright. {@link applyFederatedPeerWatermarks} closes both gaps: it
//      keeps only the LAST bundle per `instanceId` in a batch, persists a per-instance high-water mark
//      (`generatedAt`) so an old-but-still-fresh bundle can never be replayed forever, and caps how many
//      distinct instanceIds a single verifying key may ever contribute.
//
// #6477 explicitly rejected building a reputation/decay/scoring system for trust, so there is deliberately no
// per-peer score, no anomaly heuristic, and no retroactive poisoned-bundle detection here: an operator who
// discovers a bad peer removes its key from the allowlist. The Sybil cap above is a bound on how much damage
// one STILL-TRUSTED key can do, not a reputation system for individual peers.
import { createHash, createHmac } from "node:crypto";
import { MIN_DECIDED } from "./analytics";
import {
  canonicalizeFederatedBundleBody,
  FEDERATED_BUNDLE_SCHEMA_VERSION,
  resolveFederatedWindowDays,
  type FederatedSignalBundle,
  type FederatedSignalBundleBody,
} from "./federated-bundle";
import { timingSafeEqualHex } from "../utils/crypto";
import type { FocusManifest } from "../signals/focus-manifest";

/** A pulled bundle older than this (relative to `now`) is rejected rather than counted forever — closes the
 *  "re-serve one favorable year-old bundle" hole (#9148). Generous relative to DEFAULT_WINDOW_DAYS so a
 *  best-effort background sync that occasionally misses a tick for a day or two never starts rejecting a
 *  peer that is still perfectly healthy. */
const MAX_BUNDLE_AGE_MS = 7 * 86_400_000;

/** How far into the future a `generatedAt` may claim to be before it's rejected outright, rather than merely
 *  accepted with a skewed clock. Generous enough to absorb real clock drift between two independent
 *  self-hosted instances without opening a meaningful backdating/replay window. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** #9490: hard cap on `instanceId` length -- see isBundleBodyShaped's own comment for why this is a
 *  persistence-integrity bound, not a cosmetic one. */
export const MAX_INSTANCE_ID_CHARS = 128;

/** How many DISTINCT `instanceId`s a single verifying key may ever contribute to the accepted set (#9148).
 *  Without this, one allowlisted key can mint an unbounded number of fabricated instanceIds and dominate the
 *  peer median outright — the allowlist bounds which KEYS are trusted, not how many PEERS a key may claim to
 *  speak for. Deliberately generous: this is a ceiling on abuse, not a realistic peer-count expectation for
 *  a self-hosted federation of this scale. */
const MAX_INSTANCES_PER_KEY = 10;

/** Peer-state entries not refreshed in this long are pruned on the next tick, so a key that stops presenting
 *  a stale instanceId eventually frees its slot under the cap above, rather than permanently consuming it. */
const PEER_STATE_PRUNE_AFTER_MS = 400 * 86_400_000;

/** Why a bundle was not folded in. Every rejection carries one of these, so a rejection is always traceable to
 *  a specific rule rather than vanishing silently (#6480 requires rejections be operator-visible). */
export type FederatedRejectionReason =
  /** The operator never opted in — nothing inbound is processed at all. */
  | "not_opted_in"
  /** `peerKeys` is empty: the operator trusts no peer yet, so nothing can verify. Fail closed. */
  | "no_trusted_peers"
  /** Not a bundle shape this build understands — never guessed at, per FEDERATED_BUNDLE_SCHEMA_VERSION. */
  | "unsupported_schema_version"
  /** Structurally malformed: a field the signature covers is missing or the wrong type. */
  | "malformed"
  /** No allowlisted key reproduces the signature: either an untrusted peer or a tampered body. These are
   *  deliberately ONE reason — with a detached HMAC the receiver cannot distinguish them, and pretending
   *  otherwise would report a distinction this scheme cannot actually make. */
  | "untrusted_or_tampered"
  /** A signature-covered numeric field is outside its valid range (e.g. a rate outside [0,1], a negative
   *  count) (#9148). Distinct from "malformed": the field has the RIGHT TYPE, just an impossible value. */
  | "out_of_range"
  /** `windowDays` does not match the LOCAL instance's own resolved window, so the values are not comparable —
   *  #9148, closing "mixing windowDays: 7 with windowDays: 365 bundles into one median is uncaught". */
  | "window_mismatch"
  /** `generatedAt` is unparseable, too far in the future for plausible clock skew, or older than
   *  MAX_BUNDLE_AGE_MS — #9148, closing "re-serve one favorable year-old bundle forever". */
  | "stale_or_future"
  /** `decided` is below MIN_DECIDED — the sender's own eligibility bar, enforced receiver-side rather than
   *  trusted from the sender (#9148: nothing previously stopped a peer self-reporting `decided: 3,
   *  mergePrecision: 1.0`). */
  | "below_min_decided"
  /** This exact `instanceId` already has a NEWER `generatedAt` on record — a replay or clock-rollback of an
   *  otherwise-valid bundle (#9148, the persisted high-water mark). Only ever produced by
   *  {@link applyFederatedPeerWatermarks}, which is the one place this pipeline touches the DB. */
  | "replayed_or_rollback"
  /** #9490: this `instanceId` is already bound to a DIFFERENT verifying key. First-writer-wins: the id was
   *  admitted under one key's fingerprint, and a bundle for the same id verifying under any other allowlisted
   *  key is rejected outright — the takeover primitive (shadow an honest peer's id, ratchet its watermark,
   *  suppress its genuine bundles) must not exist even between two currently-trusted keys. */
  | "instance_key_conflict"
  /** This `instanceId` is new, and admitting it would push its verifying key over MAX_INSTANCES_PER_KEY —
   *  the per-key Sybil cap (#9148). Only ever produced by {@link applyFederatedPeerWatermarks}. */
  | "sybil_cap_exceeded";

/** One rejected bundle, reduced to what an operator can act on without leaking bundle contents. */
export interface FederatedRejection {
  /** The claimed instance handle, or null when the bundle was too malformed to read one. Opaque, not identity. */
  instanceId: string | null;
  reason: FederatedRejectionReason;
}

export interface FederatedImportResult {
  /** Bundles that passed every gate and may be folded into calibration / the peer median. */
  accepted: FederatedSignalBundle[];
  /** Every bundle that did not, with the rule that stopped it. */
  rejected: FederatedRejection[];
}

/** Sink for rejection visibility. Defaults to console.warn so a rejection is never silently dropped even when
 *  a caller passes no logger — #6480 forbids a silent drop as explicitly as it forbids silent acceptance. */
export type FederatedImportLogger = (rejection: FederatedRejection) => void;

type ManifestSlice = Pick<FocusManifest, "federatedIntelligence">;

/** Is peer IMPORT armed? Opt-in (`enabled`) is necessary but NOT sufficient: an operator who turned on the
 *  export and configured no peer keys imports nothing, because trust is explicit and there is no default peer.
 *  Kept separate from isFederatedIntelligenceEnabled (the export's gate) precisely so enabling the export can
 *  never, by itself, start admitting inbound data. */
export function isFederatedImportEnabled(manifest: ManifestSlice | null | undefined): boolean {
  const config = manifest?.federatedIntelligence;
  return config?.enabled === true && config.peerKeys.length > 0;
}

/** Does `bundle` carry every signature-covered field, with the right type? Guards the canonicalization below:
 *  an absent field would otherwise serialize as `undefined` and silently change the signed bytes.
 *
 *  TYPE-SHAPE ONLY (#9148: split from the RANGE check below on purpose) — a field can be a finite number of
 *  the wrong magnitude (a rate of -3, a decided count of -1) and still pass this function; that is
 *  {@link isBundleBodyInRange}'s job. Keeping the two separate lets a caller distinguish "malformed" (wrong
 *  type — likely a schema mismatch) from "out_of_range" (right type, impossible value — likely a hostile or
 *  buggy peer) in the rejection reason it reports. */
function isBundleBodyShaped(bundle: FederatedSignalBundle): boolean {
  const numeric = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
  const nullableNumeric = (value: unknown): boolean => value === null || numeric(value);
  return (
    typeof bundle.instanceId === "string" &&
    // #9490: bounded, because instanceIds are PERSISTED into the single system_flags peer-state blob. Nothing
    // else bounded them, and the pull body cap is 1 MB total -- so roughly 3-4 bundles carrying ~600 KB ids
    // pushed that blob past D1's ~2 MB value limit, writeFederatedPeerState swallowed the failure, and replay/
    // rollback watermarks silently stopped persisting for EVERY peer. 128 chars fits every reasonable id
    // scheme (a UUID is 36, a hex fingerprint 64) with headroom.
    bundle.instanceId.length > 0 &&
    bundle.instanceId.length <= MAX_INSTANCE_ID_CHARS &&
    typeof bundle.generatedAt === "string" &&
    typeof bundle.signature === "string" &&
    numeric(bundle.windowDays) &&
    numeric(bundle.decided) &&
    numeric(bundle.reversalRate) &&
    numeric(bundle.slopRate) &&
    numeric(bundle.copycatRate) &&
    nullableNumeric(bundle.mergePrecision) &&
    nullableNumeric(bundle.closePrecision) &&
    nullableNumeric(bundle.fpRate) &&
    nullableNumeric(bundle.fnRate) &&
    nullableNumeric(bundle.cycleP50Ms) &&
    nullableNumeric(bundle.cycleP95Ms)
  );
}

/** Is every numeric field within the range its own semantics allow? Only called once {@link isBundleBodyShaped}
 *  has already confirmed every field is a finite number (or, for the nullable ones, null) — this function
 *  never needs to re-guard against `NaN`/`Infinity`/wrong-typeof itself. A rate field outside [0, 1], a
 *  negative count, or `cycleP50Ms > cycleP95Ms` (the median can never exceed the p95 of the same sample) all
 *  fail here (#9148). */
function isBundleBodyInRange(bundle: FederatedSignalBundle): boolean {
  const unitRate = (value: number | null): boolean => value === null || (value >= 0 && value <= 1);
  const nonNegative = (value: number | null): boolean => value === null || value >= 0;
  if (bundle.windowDays <= 0) return false;
  if (bundle.decided < 0) return false;
  if (!unitRate(bundle.reversalRate) || !unitRate(bundle.slopRate) || !unitRate(bundle.copycatRate)) return false;
  if (!unitRate(bundle.mergePrecision) || !unitRate(bundle.closePrecision)) return false;
  if (!unitRate(bundle.fpRate) || !unitRate(bundle.fnRate)) return false;
  if (!nonNegative(bundle.cycleP50Ms) || !nonNegative(bundle.cycleP95Ms)) return false;
  if (bundle.cycleP50Ms !== null && bundle.cycleP95Ms !== null && bundle.cycleP50Ms > bundle.cycleP95Ms) return false;
  return true;
}

/** Strip the detached signature back off, so the body is canonicalized over exactly the fields the sender
 *  signed. Rebuilt field-by-field rather than by deleting `signature` from a copy: the canonical form is a
 *  fixed key list, so an extra property a peer appended can never reach the signed bytes. */
function toBody(bundle: FederatedSignalBundle): FederatedSignalBundleBody {
  return {
    schemaVersion: bundle.schemaVersion,
    instanceId: bundle.instanceId,
    generatedAt: bundle.generatedAt,
    windowDays: bundle.windowDays,
    decided: bundle.decided,
    mergePrecision: bundle.mergePrecision,
    closePrecision: bundle.closePrecision,
    fpRate: bundle.fpRate,
    fnRate: bundle.fnRate,
    reversalRate: bundle.reversalRate,
    cycleP50Ms: bundle.cycleP50Ms,
    cycleP95Ms: bundle.cycleP95Ms,
    slopRate: bundle.slopRate,
    copycatRate: bundle.copycatRate,
  };
}

/**
 * Which allowlisted key (if any) verifies `bundle`'s signature — the value itself, not an index, since
 * `peerKeys` order is operator config and not a stable identity (#9148's per-key Sybil-cap fingerprinting
 * needs a value stable across config edits that don't touch that specific key).
 *
 * Every candidate key is tried because the HMAC is detached and carries no key hint — the bundle says which
 * INSTANCE it claims to be from, but `instanceId` is unauthenticated until a key verifies, so selecting a key
 * by it would trust the attacker-controlled field to pick its own verifier.
 *
 * The comparison is timing-safe (timingSafeEqualHex), and the loop deliberately does NOT early-exit on a match:
 * it verifies against all keys, so total work does not depend on WHICH key matched (or whether one did).
 */
export function matchingFederatedKey(bundle: FederatedSignalBundle, peerKeys: readonly string[]): string | null {
  const canonical = canonicalizeFederatedBundleBody(toBody(bundle));
  let matched: string | null = null;
  for (const key of peerKeys) {
    const expected = createHmac("sha256", key).update(canonical).digest("hex");
    if (timingSafeEqualHex(bundle.signature, expected)) matched = key;
  }
  return matched;
}

/** Does `bundle`'s signature verify against ANY key the operator allowlisted? Thin boolean wrapper over
 *  {@link matchingFederatedKey} — kept as its own export because most callers (and every existing test) only
 *  need the yes/no answer, not which key matched. */
export function verifyFederatedBundle(bundle: FederatedSignalBundle, peerKeys: readonly string[]): boolean {
  return matchingFederatedKey(bundle, peerKeys) !== null;
}

/** Apply every STATELESS gate to a single bundle (no DB, no network) — schema, shape, range, signature,
 *  freshness, and window-match. Returns null when it may proceed to the persisted per-instance gates in
 *  {@link applyFederatedPeerWatermarks}, or the reason it may not. */
function rejectionFor(bundle: FederatedSignalBundle, peerKeys: readonly string[], now: number, localWindowDays: number): FederatedRejectionReason | null {
  if (bundle?.schemaVersion !== FEDERATED_BUNDLE_SCHEMA_VERSION) return "unsupported_schema_version";
  if (!isBundleBodyShaped(bundle)) return "malformed";
  if (!isBundleBodyInRange(bundle)) return "out_of_range";
  if (!verifyFederatedBundle(bundle, peerKeys)) return "untrusted_or_tampered";
  if (bundle.windowDays !== localWindowDays) return "window_mismatch";
  const generatedAtMs = Date.parse(bundle.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return "stale_or_future";
  if (now - generatedAtMs > MAX_BUNDLE_AGE_MS || generatedAtMs - now > MAX_CLOCK_SKEW_MS) return "stale_or_future";
  if (bundle.decided < MIN_DECIDED) return "below_min_decided";
  return null;
}

/**
 * Trust-gate a batch of pulled peer bundles, returning only those an operator's own config says to trust.
 *
 * FAIL-SAFE, MOSTLY PURE: this function reads no DB and makes no network call — the gate never consults it,
 * so neither a rejected nor a malformed bundle can reach this instance's own review/merge behavior. (The one
 * exception in this module is {@link applyFederatedPeerWatermarks}, a separate function that DOES touch the
 * DB, called only from the federated background sync job — never from any gate-facing path either.)
 *
 * Applies every stateless gate (#9148: schema, shape, range, signature, freshness, and window-match) and
 * dedups within the batch by `instanceId`, keeping only the LAST bundle for each — closing the other half of
 * the Sybil gap: a single verifying key signing many bundles for the SAME fabricated instanceId in one pull
 * no longer counts multiple times toward the median.
 */
export function importPeerBundles(
  manifest: ManifestSlice | null | undefined,
  bundles: readonly FederatedSignalBundle[],
  opts: { log?: FederatedImportLogger; now?: number; localWindowDays?: number } = {},
): FederatedImportResult {
  const log = opts.log ?? defaultRejectionLogger;
  const reject = (instanceId: string | null, reason: FederatedRejectionReason): FederatedRejection => {
    const rejection: FederatedRejection = { instanceId, reason };
    log(rejection);
    return rejection;
  };

  const config = manifest?.federatedIntelligence;
  // Opted out and no-trusted-peers are reported per bundle rather than once: an operator watching the log for
  // "why did nothing import?" needs the answer attached to the bundles that were actually dropped.
  if (config?.enabled !== true) {
    return { accepted: [], rejected: bundles.map((bundle) => reject(instanceIdOf(bundle), "not_opted_in")) };
  }
  if (config.peerKeys.length === 0) {
    return { accepted: [], rejected: bundles.map((bundle) => reject(instanceIdOf(bundle), "no_trusted_peers")) };
  }

  const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
  const localWindowDays = Number.isFinite(opts.localWindowDays) ? (opts.localWindowDays as number) : resolveFederatedWindowDays(undefined);

  const rejected: FederatedRejection[] = [];
  // Keep only the LAST bundle per instanceId (a Map preserves insertion order but re-set moves nothing, so we
  // delete-then-set to push a re-seen id to the end — irrelevant to correctness here since only the VALUE at
  // each key is read back below, never iteration order, but matches the "last wins" contract literally).
  const acceptedByInstance = new Map<string, FederatedSignalBundle>();
  for (const bundle of bundles) {
    const reason = rejectionFor(bundle, config.peerKeys, now, localWindowDays);
    if (reason !== null) {
      rejected.push(reject(instanceIdOf(bundle), reason));
      continue;
    }
    acceptedByInstance.set(bundle.instanceId, bundle);
  }
  return { accepted: [...acceptedByInstance.values()], rejected };
}

/** The claimed handle, or null when the bundle is too malformed to carry one. Unauthenticated until a
 *  signature verifies — only ever used to label a log line, never to select a key or a trust decision. */
function instanceIdOf(bundle: FederatedSignalBundle): string | null {
  return typeof bundle?.instanceId === "string" ? bundle.instanceId : null;
}

/** system_flags key for the persisted per-instance peer state (#9148): a single JSON blob keyed by
 *  instanceId, mirroring the get-or-create secret pattern this subsystem already uses elsewhere
 *  (federated-bundle.ts's FEDERATED_SIGNING_SECRET_FLAG). A dedicated table was deliberately NOT added: a
 *  self-hosted federation's peer count is expected to stay in the tens at most, so scanning/filtering the
 *  whole blob in JS on each tick is trivially cheap and avoids a migration for what is bookkeeping state, not
 *  a queryable relation. Revisit with a real table + index if that scale assumption ever stops holding. */
const FEDERATED_PEER_STATE_FLAG_KEY = "orb:federated_peer_state";

interface FederatedPeerStateEntry {
  /** SHA-256 hex of the verifying key, so the Sybil cap can be enforced without persisting the key itself. */
  keyFingerprint: string;
  /** Epoch ms of the newest `generatedAt` accepted for this instanceId — the replay/rollback watermark. */
  lastGeneratedAtMs: number;
  /** Epoch ms this entry was last refreshed — drives PEER_STATE_PRUNE_AFTER_MS. */
  lastSeenAtMs: number;
  /** Epoch ms this instanceId was first admitted — informational only, never read for a gating decision. */
  firstSeenAtMs: number;
}

type FederatedPeerState = Record<string, FederatedPeerStateEntry>;

/** SHA-256 hex of a peer verification key — a stable handle for the Sybil cap that never persists the key
 *  value itself (mirrors this codebase's convention of never logging/storing a raw credential). */
function federatedKeyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Reads the persisted peer-state blob. Fails safe to `{}` on any error (missing row, corrupt JSON, a D1
 *  outage) — an unreadable cache degrades to "every instanceId looks new", never to a thrown error, matching
 *  every other read helper in this subsystem. */
async function readFederatedPeerState(db: D1Database): Promise<FederatedPeerState> {
  try {
    const row = await db.prepare("SELECT value FROM system_flags WHERE key = ?").bind(FEDERATED_PEER_STATE_FLAG_KEY).first<{ value: string }>();
    if (!row?.value) return {};
    const parsed: unknown = JSON.parse(row.value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FederatedPeerState) : {};
  } catch {
    return {};
  }
}

/** Best-effort write of the peer-state blob. A write failure must never fail the sync tick — the next tick
 *  simply recomputes from a stale-but-still-usable snapshot. */
async function writeFederatedPeerState(db: D1Database, state: FederatedPeerState): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .bind(FEDERATED_PEER_STATE_FLAG_KEY, JSON.stringify(state))
    .run()
    .catch((error: unknown) => {
      // #9490: still fail-open (a write failure must never fail the sync tick), but LOUDLY. This blob carries
      // the replay/rollback watermarks and the Sybil cap's instance ledger for every peer -- a persistent
      // write failure silently regresses all of #9148's protections, which an operator needs to SEE, not
      // infer. error level so the structured-log forwarder picks it up, same convention as
      // regate_repair_exhausted.
      console.error(
        JSON.stringify({
          level: "error",
          event: "federated_peer_state_write_failed",
          instances: Object.keys(state).length,
          approxBytes: JSON.stringify(state).length,
          message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        }),
      );
    });
}

/**
 * Applies the two PERSISTED gates #9148 requires on top of {@link importPeerBundles}'s stateless result: a
 * per-instance replay/rollback watermark, and a per-key Sybil cap for brand-new instanceIds. This is the ONE
 * function in this module that touches the DB — deliberately kept separate from `importPeerBundles` (which
 * stays pure) and called ONLY from the federated background sync job (federated-sync.ts), never from any
 * gate-facing path, so the "no path from here to a gate decision" property importPeerBundles documents still
 * holds structurally for the pure core.
 *
 * `peerKeys` must be the SAME allowlist `result.accepted` was already verified against — every bundle in
 * `result.accepted` is therefore guaranteed to match one of them (the `null` arm below is defensive only).
 */
export async function applyFederatedPeerWatermarks(
  db: D1Database,
  result: FederatedImportResult,
  peerKeys: readonly string[],
  opts: { now?: number; log?: FederatedImportLogger } = {},
): Promise<FederatedImportResult> {
  const log = opts.log ?? defaultRejectionLogger;
  const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
  const reject = (instanceId: string | null, reason: FederatedRejectionReason): FederatedRejection => {
    const rejection: FederatedRejection = { instanceId, reason };
    log(rejection);
    return rejection;
  };

  const state = await readFederatedPeerState(db);
  for (const [id, entry] of Object.entries(state)) {
    if (now - entry.lastSeenAtMs > PEER_STATE_PRUNE_AFTER_MS) delete state[id];
  }

  const accepted: FederatedSignalBundle[] = [];
  const rejected: FederatedRejection[] = [...result.rejected];
  for (const bundle of result.accepted) {
    const key = matchingFederatedKey(bundle, peerKeys);
    /* v8 ignore next 4 -- defensive: every bundle in result.accepted already verified against this exact
       peerKeys allowlist inside importPeerBundles, so a re-check here can only fail if the caller passed a
       DIFFERENT allowlist than it used to produce `result` — a caller contract violation, not a reachable
       runtime state. */
    if (key === null) {
      rejected.push(reject(bundle.instanceId, "untrusted_or_tampered"));
      continue;
    }
    const fingerprint = federatedKeyFingerprint(key);
    const generatedAtMs = Date.parse(bundle.generatedAt); // already validated finite by importPeerBundles' rejectionFor
    const existing = state[bundle.instanceId];
    if (existing) {
      // #9490: an instanceId is BOUND to the first key that verified it. Without this, any hostile-but-
      // allowlisted peer B could claim honest peer A's id: shadow A's bundle in-batch (last-wins dedup keys
      // on id alone), overwrite the watermark entry's keyFingerprint, then ratchet lastGeneratedAtMs forward
      // so A's genuine bundles reject as replayed_or_rollback forever -- targeted suppression plus stat
      // replacement, and a bypass of B's own MAX_INSTANCES_PER_KEY cap (only NEW ids are counted against it).
      // That sits squarely inside #9148's declared threat model: bound the damage one still-trusted key can
      // do. The binding is first-writer-wins and permanent for the life of the state entry; a peer that
      // legitimately rotates keys re-enters under a new id (or after PEER_STATE_PRUNE_AFTER_MS frees the old
      // one), which is the cheap, honest path -- as opposed to any takeover path existing at all.
      if (existing.keyFingerprint !== fingerprint) {
        rejected.push(reject(bundle.instanceId, "instance_key_conflict"));
        continue;
      }
      if (generatedAtMs <= existing.lastGeneratedAtMs) {
        rejected.push(reject(bundle.instanceId, "replayed_or_rollback"));
        continue;
      }
      state[bundle.instanceId] = { keyFingerprint: fingerprint, lastGeneratedAtMs: generatedAtMs, lastSeenAtMs: now, firstSeenAtMs: existing.firstSeenAtMs };
      accepted.push(bundle);
      continue;
    }
    const liveInstancesForKey = Object.values(state).filter((entry) => entry.keyFingerprint === fingerprint).length;
    if (liveInstancesForKey >= MAX_INSTANCES_PER_KEY) {
      rejected.push(reject(bundle.instanceId, "sybil_cap_exceeded"));
      continue;
    }
    state[bundle.instanceId] = { keyFingerprint: fingerprint, lastGeneratedAtMs: generatedAtMs, lastSeenAtMs: now, firstSeenAtMs: now };
    accepted.push(bundle);
  }

  await writeFederatedPeerState(db, state);
  return { accepted, rejected };
}

/** Operator-visible by default. Logs the reason and the opaque instance handle only — never bundle contents,
 *  never a peer key, so a rejection is diagnosable without the log becoming a place secrets leak. */
function defaultRejectionLogger(rejection: FederatedRejection): void {
  console.warn(`[federated-import] rejected peer bundle (instance=${rejection.instanceId ?? "unknown"}): ${rejection.reason}`);
}
