// LoopOver federated fleet intelligence (#1970) — OPT-IN, peer bundle IMPORT + trust-gating (#6480).
//
// This is the RECEIVING side: it decides whether a bundle pulled by the transport client
// (src/orb/federated-collector.ts, #6479) may be folded into local calibration or the peer-median benchmark
// (#6481) at all. The export side is #6478 (src/orb/federated-bundle.ts).
//
// The trust model is #6477's DESIGN DECISION, implemented here exactly as specified and deliberately NOT
// redesigned. Its two poisoning-resistance layers, and where each one actually lives:
//   1. ALLOWLIST — only a peer whose verification key the operator explicitly added to
//      `federatedIntelligence.peerKeys` is ever considered. That is enforced HERE, and it is why a Sybil
//      attack is self-limiting by construction: forging peers requires the RECEIVING operator to have added
//      the attacker's keys themselves. Mirrors MCP_READ_REPO_ALLOWLIST's posture: explicit operator config,
//      fail closed when unset, never auto-discovery and never a PKI.
//   2. MEDIAN, NOT MEAN — a bounded number of outliers cannot drag a median arbitrarily, unlike a mean. That
//      layer needs no code here: the fleet aggregation this feeds already medians (src/orb/analytics.ts:92),
//      so it holds by construction. Re-implementing it in this module would fork the definition #6481's
//      comparison depends on.
//
// #6477 explicitly rejected building a reputation/decay/scoring system for trust, so there is deliberately no
// per-peer score, no anomaly heuristic, and no retroactive poisoned-bundle detection here: an operator who
// discovers a bad peer removes its key from the allowlist. Adding any of those would be inventing a mechanism
// that design pass considered and turned down.
import { canonicalizeFederatedBundleBody, FEDERATED_BUNDLE_SCHEMA_VERSION, type FederatedSignalBundle, type FederatedSignalBundleBody } from "./federated-bundle";
import { timingSafeEqualHex } from "../utils/crypto";
import type { FocusManifest } from "../signals/focus-manifest";
import { createHmac } from "node:crypto";

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
  | "untrusted_or_tampered";

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
 *  an absent field would otherwise serialize as `undefined` and silently change the signed bytes. */
function isBundleBodyShaped(bundle: FederatedSignalBundle): boolean {
  const numeric = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
  const nullableNumeric = (value: unknown): boolean => value === null || numeric(value);
  return (
    typeof bundle.instanceId === "string" &&
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
 * Does `bundle`'s signature verify against ANY key the operator allowlisted?
 *
 * Every candidate key is tried because the HMAC is detached and carries no key hint — the bundle says which
 * INSTANCE it claims to be from, but `instanceId` is unauthenticated until a key verifies, so selecting a key
 * by it would trust the attacker-controlled field to pick its own verifier.
 *
 * The comparison is timing-safe (timingSafeEqualHex), and the loop deliberately does NOT early-exit on a match:
 * it verifies against all keys and ORs the results, so total work does not depend on WHICH key matched.
 */
export function verifyFederatedBundle(bundle: FederatedSignalBundle, peerKeys: readonly string[]): boolean {
  const canonical = canonicalizeFederatedBundleBody(toBody(bundle));
  let verified = false;
  for (const key of peerKeys) {
    const expected = createHmac("sha256", key).update(canonical).digest("hex");
    if (timingSafeEqualHex(bundle.signature, expected)) verified = true;
  }
  return verified;
}

/** Apply every gate to a single bundle. Returns null when it may be folded in, or the reason it may not. */
function rejectionFor(bundle: FederatedSignalBundle, peerKeys: readonly string[]): FederatedRejectionReason | null {
  if (bundle?.schemaVersion !== FEDERATED_BUNDLE_SCHEMA_VERSION) return "unsupported_schema_version";
  if (!isBundleBodyShaped(bundle)) return "malformed";
  if (!verifyFederatedBundle(bundle, peerKeys)) return "untrusted_or_tampered";
  return null;
}

/**
 * Trust-gate a batch of pulled peer bundles, returning only those an operator's own config says to trust.
 *
 * FAIL-SAFE: this is a pure function the gate never consults — it reads no DB, makes no network call, and
 * returns a value rather than mutating anything, so neither a rejected nor a malformed bundle can reach this
 * instance's own review/merge behavior. That is the structural version of #6480's fail-safe requirement: there
 * is no path from here to a gate decision, rather than a guard that could be forgotten.
 */
export function importPeerBundles(
  manifest: ManifestSlice | null | undefined,
  bundles: readonly FederatedSignalBundle[],
  opts: { log?: FederatedImportLogger } = {},
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

  const accepted: FederatedSignalBundle[] = [];
  const rejected: FederatedRejection[] = [];
  for (const bundle of bundles) {
    const reason = rejectionFor(bundle, config.peerKeys);
    if (reason === null) accepted.push(bundle);
    else rejected.push(reject(instanceIdOf(bundle), reason));
  }
  return { accepted, rejected };
}

/** The claimed handle, or null when the bundle is too malformed to carry one. Unauthenticated until a
 *  signature verifies — only ever used to label a log line, never to select a key or a trust decision. */
function instanceIdOf(bundle: FederatedSignalBundle): string | null {
  return typeof bundle?.instanceId === "string" ? bundle.instanceId : null;
}

/** Operator-visible by default. Logs the reason and the opaque instance handle only — never bundle contents,
 *  never a peer key, so a rejection is diagnosable without the log becoming a place secrets leak. */
function defaultRejectionLogger(rejection: FederatedRejection): void {
  console.warn(`[federated-import] rejected peer bundle (instance=${rejection.instanceId ?? "unknown"}): ${rejection.reason}`);
}
