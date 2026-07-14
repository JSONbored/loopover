// Per-tenant configuration layer (pure) — #4787, part of the Rent-a-Loop path #4778.
//
// A customer's own autonomy/config, scoped strictly to their rented repo and independent of gittensory's own
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
      maxConcurrentLoops: prefs.maxConcurrentLoops ?? base.preferences.maxConcurrentLoops,
      pauseOnFailure: prefs.pauseOnFailure ?? base.preferences.pauseOnFailure,
      allowedActionClasses: [...(prefs.allowedActionClasses ?? base.preferences.allowedActionClasses)],
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
  return Object.freeze({ ...store, [tenantId]: resolveTenantConfig(overrides) });
}

/** Read a tenant's effective config, falling back to a fresh copy of the defaults when they've set none. */
export function getTenantConfig(store: TenantConfigStore, tenantId: string): TenantConfig {
  return store[tenantId] ?? resolveTenantConfig();
}
