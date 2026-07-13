// Per-repo RegistryLaneSpec resolution (#2435 — closes the "only metagraphed can use this" gap). Before this,
// content-lane-wire.ts hard-selected METAGRAPHED_LANE_SPEC for every repo in the LOOPOVER_REVIEW_REPOS
// allowlist; a different self-hosted maintainer's registry could only be onboarded by editing gittensory's own
// TypeScript source. This mirrors resolveConvergedFeature's precedence (review/feature-activation.ts): env
// kill-switch → per-repo `.gittensory.yml` config → allowlist default — but resolves to a whole spec OBJECT (or
// null/inactive) instead of a boolean, so it lives alongside the content-lane engine rather than in
// feature-activation.ts itself, which only knows about boolean converged features.
import { globToRegExp } from "../../signals/change-guardrail";
import type { FocusManifest, FocusManifestContentLaneConfig } from "../../signals/focus-manifest";
import { isConvergenceRepoAllowed } from "../cutover-gate";
import { type ContentLaneEnv, isContentLaneEnabled } from "./flag";
import { assessProviderDocument, assessSubnetDocument, METAGRAPHED_LANE_SPEC, type RegistryLaneSpec } from "./registry-logic";

/**
 * Code-registered, PR-reviewed domain validators a maintainer's `.gittensory.yml` `contentLane.validatorId` can
 * reference by name — mirrors the existing `GatePolicyPack` pattern (`gate.pack` in `.gittensory.yml`, branched
 * on in `rules/predicted-gate.ts`): config picks a string id that selects one of a small, code-reviewed set of
 * behavior bundles, rather than a maintainer supplying arbitrary logic through config. Semantic validation stays
 * a deliberate, bounded, one-time code contribution (a new validator module + a one-line registration here,
 * using metagraphed's own module as the template) — everything else about a registry (file patterns, entry-count
 * cap, dedup fields) is pure config, no code change required.
 */
const REGISTRY_VALIDATORS: Record<string, Pick<RegistryLaneSpec, "assessAppendedEntry" | "assessProviderEntry">> = {
  metagraphed: { assessAppendedEntry: assessSubnetDocument, assessProviderEntry: assessProviderDocument },
};

/**
 * Builds a RegistryLaneSpec from a manifest's `contentLane:` block. Returns null when the config isn't "present"
 * (parseContentLaneConfig already treats a partial config — missing entryFileGlob/collectionField — as absent,
 * so `present` here always implies both are set). Glob fields compile via the SAME bounded glob compiler used
 * for guardrail paths (change-guardrail.ts) — never a raw regex from a maintainer-supplied string, matching this
 * codebase's established ReDoS-avoidance convention. An unregistered `validatorId` degrades to structural gating
 * only (no domain-specific validator), the same degraded mode a spec with no validatorId configured at all gets
 * — never a crash or a silent skip of the count/dedup checks.
 */
export function buildRegistryLaneSpecFromConfig(config: FocusManifestContentLaneConfig): RegistryLaneSpec | null {
  if (!config.present || !config.entryFileGlob || !config.collectionField) return null;
  const validator = config.validatorId && Object.hasOwn(REGISTRY_VALIDATORS, config.validatorId) ? REGISTRY_VALIDATORS[config.validatorId] : undefined;
  return {
    entryFilePattern: globToRegExp(config.entryFileGlob),
    collectionField: config.collectionField,
    ...(config.providerFileGlob ? { providerFilePattern: globToRegExp(config.providerFileGlob) } : {}),
    ...(config.artifactGlob ? { artifactPattern: globToRegExp(config.artifactGlob) } : {}),
    ...(config.maxAppendedEntries !== null ? { maxAppendedEntries: config.maxAppendedEntries } : {}),
    ...(config.duplicateKeyFields.length > 0 ? { duplicateKeyFields: config.duplicateKeyFields } : {}),
    ...(validator ?? {}),
  };
}

/**
 * True when `config.validatorId` is set but does not match any REGISTRY_VALIDATORS entry — most likely an
 * operator typo in `.gittensory.yml`'s `contentLane.validatorId` (e.g. "metagraph" instead of "metagraphed").
 * `buildRegistryLaneSpecFromConfig` above already degrades this to structural-only gating silently (never a
 * crash — a brand-new registry with no validator contributed yet is a legitimate config), which makes a typo
 * indistinguishable from a deliberate choice. Checked as a SEPARATE pure function so a caller (see
 * `evaluateWithSurfaceLane` in `content-lane-wire.ts`) can surface it as an operator-visible advisory finding
 * without changing `buildRegistryLaneSpecFromConfig`'s established `RegistryLaneSpec | null` return contract.
 * Returns the offending id, or null when there is nothing to warn about (no validatorId configured, or it
 * resolves). PURE.
 */
export function unregisteredValidatorId(config: FocusManifestContentLaneConfig | null | undefined): string | null {
  if (!config?.validatorId) return null;
  return Object.hasOwn(REGISTRY_VALIDATORS, config.validatorId) ? null : config.validatorId;
}

/** The validatorId strings a maintainer's `.gittensory.yml` `contentLane.validatorId` can currently reference —
 *  exposed so a caller can render a helpful "known validators are: X, Y" hint alongside an
 *  `unregisteredValidatorId` warning, without reaching into REGISTRY_VALIDATORS directly. */
export function registeredValidatorIds(): string[] {
  return Object.keys(REGISTRY_VALIDATORS);
}

/**
 * Resolve the effective RegistryLaneSpec for a repo, or null when the content lane is inactive. PURE +
 * synchronous (takes an already-loaded manifest), mirroring `resolveConvergedFeature`'s precedence: env
 * kill-switch (off ⇒ null, no per-repo override can turn it back on) → an explicit per-repo `contentLane:`
 * config → the allowlist-based default (METAGRAPHED_LANE_SPEC — today's zero-config behavior, UNCHANGED for any
 * repo that hasn't opted into its own config) → inactive.
 */
export function resolveRegistryLaneSpec(
  env: ContentLaneEnv & { LOOPOVER_REVIEW_REPOS?: string | undefined },
  manifest: Pick<FocusManifest, "contentLane"> | null | undefined,
  repoFullName: string,
): RegistryLaneSpec | null {
  if (!isContentLaneEnabled(env)) return null;
  const configured = manifest?.contentLane ? buildRegistryLaneSpecFromConfig(manifest.contentLane) : null;
  if (configured) return configured;
  return isConvergenceRepoAllowed(env, repoFullName) ? METAGRAPHED_LANE_SPEC : null;
}
