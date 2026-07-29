// Per-tenant configuration layer (pure) — #4787, part of the Rent-a-Loop path #4778.
//
// A customer's own autonomy/config, scoped strictly to their rented repo and independent of loopover's own
// configuration. Deterministic and side-effect-free: it resolves a tenant's effective config from the defaults
// plus their overrides, and holds per-tenant configs in an IMMUTABLE store. Isolation is guaranteed by
// construction — every resolve returns a NEW config with freshly-copied collections, and every store update
// returns a NEW store, so setting or mutating one tenant's config can never affect another tenant's config or
// the shared defaults (the no-cross-contamination requirement). The autonomy level mirrors #4782's graduated
// dial (taken as a value here, not depending on its wiring). This resolves and holds config only — persisting
// it to a datastore is a separate, maintainer-owned concern.

export type TenantAutonomyLevel = "off" | "suggest" | "assist" | "auto";

export const TENANT_AUTONOMY_LEVELS: readonly TenantAutonomyLevel[] = ["off", "suggest", "assist", "auto"];

/** Repo-specific execution preferences a tenant can tune for their own loop. */
export type TenantExecutionPreferences = {
  maxConcurrentLoops: number;
  pauseOnFailure: boolean;
  allowedActionClasses: readonly string[];
};

export type TenantConfig = {
  autonomyLevel: TenantAutonomyLevel;
  preferences: TenantExecutionPreferences;
};

export type TenantConfigOverrides = {
  autonomyLevel?: TenantAutonomyLevel | undefined;
  preferences?: Partial<TenantExecutionPreferences> | undefined;
};

/** The conservative baseline a tenant inherits until they override it. */
export const DEFAULT_TENANT_CONFIG: TenantConfig = {
  autonomyLevel: "suggest",
  preferences: { maxConcurrentLoops: 1, pauseOnFailure: true, allowedActionClasses: ["open_pr", "comment"] },
};

/**
 * Resolve a tenant's effective config from the defaults plus their overrides. Pure and fully isolated: the
 * returned config shares no mutable reference with the defaults or any other resolution — the action-class list
 * is copied on every call — so mutating one tenant's config can never affect another's. An override with an
 * unrecognized autonomy level falls back to the default level rather than trusting arbitrary input.
 */
// #9614: normalize any numeric input to a non-negative integer (a non-finite or negative value becomes 0) --
// the exact body used in tenant-quota.ts:45-47 / loop-consumption.ts / worktree-pool.ts (the #5828
// finiteNonNegativeInt discipline), so maxConcurrentLoops can never resolve NaN, fractional, negative, or Infinity.
function finiteNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function resolveTenantConfig(overrides: TenantConfigOverrides = {}): TenantConfig {
  const base = DEFAULT_TENANT_CONFIG;
  const autonomyLevel =
    overrides.autonomyLevel !== undefined && TENANT_AUTONOMY_LEVELS.includes(overrides.autonomyLevel)
      ? overrides.autonomyLevel
      : base.autonomyLevel;
  const prefs = overrides.preferences ?? {};
  return {
    autonomyLevel,
    preferences: {
      // #9614: normalize an EXPLICITLY-supplied override (finiteNonNegativeInt); an absent override still
      // inherits DEFAULT_TENANT_CONFIG's 1, since `??` alone let -5/0.5/NaN/Infinity pass through verbatim.
      maxConcurrentLoops:
        prefs.maxConcurrentLoops !== undefined ? finiteNonNegativeInt(prefs.maxConcurrentLoops) : base.preferences.maxConcurrentLoops,
      pauseOnFailure: prefs.pauseOnFailure ?? base.preferences.pauseOnFailure,
      // #9614: drop non-string entries from an override rather than copying them through, mirroring how an
      // unrecognized autonomyLevel is refused above -- untrusted input must not smuggle a non-string action class in.
      allowedActionClasses:
        prefs.allowedActionClasses !== undefined
          ? prefs.allowedActionClasses.filter((entry): entry is string => typeof entry === "string")
          : [...base.preferences.allowedActionClasses],
    },
  };
}

/** An immutable map of tenant id → resolved config. Setting a tenant returns a new store (see below). */
export type TenantConfigStore = Readonly<Record<string, TenantConfig>>;

export const EMPTY_TENANT_CONFIG_STORE: TenantConfigStore = Object.freeze({});

/**
 * Set a tenant's config from their overrides, returning a NEW store. The updated tenant's entry is a freshly
 * resolved config; every other tenant's entry is carried over untouched, so one customer setting their config
 * can never mutate or observe another customer's. Immutable update — the input store is never modified.
 */
export function setTenantConfig(
  store: TenantConfigStore,
  tenantId: string,
  overrides: TenantConfigOverrides = {},
): TenantConfigStore {
  // #9614: deep-freeze the written entry. Object.freeze is shallow, so freeze each level (the config, its
  // preferences, and the allowedActionClasses array) -- otherwise a caller holding a reference to a nested
  // value could still mutate the stored config.
  const config = resolveTenantConfig(overrides);
  Object.freeze(config.preferences.allowedActionClasses);
  Object.freeze(config.preferences);
  Object.freeze(config);
  return Object.freeze({ ...store, [tenantId]: config });
}

// #9614: a fresh deep copy sharing no mutable reference with the stored (frozen-but-shallow) config, so a
// caller that mutates the result can never rewrite the tenant's stored preferences/allowedActionClasses.
function cloneTenantConfig(config: TenantConfig): TenantConfig {
  return {
    autonomyLevel: config.autonomyLevel,
    preferences: {
      maxConcurrentLoops: config.preferences.maxConcurrentLoops,
      pauseOnFailure: config.preferences.pauseOnFailure,
      allowedActionClasses: [...config.preferences.allowedActionClasses],
    },
  };
}

/** Read a tenant's effective config as a fresh, caller-owned copy. The returned config -- and its nested
 *  `preferences` and `allowedActionClasses` -- shares no reference with the store on EITHER path, so mutating
 *  it never affects the stored config; a tenant with none set gets a fresh copy of the defaults. */
export function getTenantConfig(store: TenantConfigStore, tenantId: string): TenantConfig {
  const stored = store[tenantId];
  return stored !== undefined ? cloneTenantConfig(stored) : resolveTenantConfig();
}
