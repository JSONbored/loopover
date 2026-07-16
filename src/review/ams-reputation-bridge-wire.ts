// Convergence (ORB/AMS reputation bridge, #6485, per #6208's decided design): the master kill-switch for the
// `amsReputationBridge` converged feature -- an UPGRADE-ONLY, pull-based bridge that lets a submitter's genuine
// AMS track record improve (never worsen) their ORB reputation standing. Mirrors the shape of
// `improvement-signal-wire.ts`/`rag-wire.ts`: this file is deliberately just the env flag, so the
// per-repo `features.amsReputationBridge` override in `.loopover.yml` has a global switch to gate on.
//
// Single env switch: LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE. Default OFF (unset/"false") -- when OFF the bridge
// never runs for any repo, regardless of a per-repo `.loopover.yml` override (see `resolveConvergedFeature` in
// `./feature-activation`), so the reputation path is byte-identical to today. Truthy follows the codebase
// convention (`/^(1|true|yes|on)$/i`, same as isReputationEnabled / isImprovementSignalEnabled).
//
// STRICTLY INTERNAL: like the `reputation` signal it extends, the bridged standing NEVER appears in any public
// comment, label, or check-run -- it only routes the private, server-side AI-spend decision.

/** True when the ORB/AMS reputation bridge is enabled at the deployment level. Flag-OFF (default) → the bridge
 *  is never active for any repo, regardless of a per-repo `features.amsReputationBridge` override. */
export function isAmsReputationBridgeEnabled(env: {
  LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE?: string | undefined;
}): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE ?? "").trim());
}

/** The operator-configured LOCAL AMS base URL the bridge pulls from, or undefined when unset/blank (⇒ the
 *  bridge applies no bonus signal even when the feature is otherwise active). Kept next to the kill-switch so
 *  both halves of this feature's deployment config resolve in one place. */
export function resolveAmsTrackRecordEndpoint(env: { LOOPOVER_AMS_TRACK_RECORD_URL?: string | undefined }): string | undefined {
  const url = (env.LOOPOVER_AMS_TRACK_RECORD_URL ?? "").trim();
  return url === "" ? undefined : url;
}
