import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/**
 * One hook instance's view of a localStorage key, as a subscribable cell.
 *
 * The cell's snapshot is the RAW STRING, never the parsed value: a string is a primitive, so the
 * snapshot is referentially stable by construction -- which is exactly what `useSyncExternalStore`
 * demands (a fresh `JSON.parse` per snapshot read would re-render forever). Parsing happens once
 * per change, in the hook.
 */
type StorageCell = {
  subscribe: (onChange: () => void) => () => void;
  getRaw: () => string | null;
  /** Same-tab write: persist, update the cell, notify. `storage` never fires in the writing tab. */
  write: (raw: string) => void;
  /** Re-read localStorage into the cell and notify, after the legacy migration writes forward. */
  refresh: () => void;
};

function createStorageCell(key: string, legacyKey: string | undefined): StorageCell {
  const listeners = new Set<() => void>();
  let raw: string | null = null;
  let loaded = false;

  /** Reads the new key, falling back to the legacy one so the value is right even before the
   *  migration effect has written it forward. Disabled storage (private mode) reads as absent. */
  const read = (): string | null => {
    try {
      const own = window.localStorage.getItem(key);
      if (own !== null) return own;
      return legacyKey === undefined ? null : window.localStorage.getItem(legacyKey);
    } catch {
      return null;
    }
  };

  const set = (next: string | null): void => {
    if (loaded && next === raw) return;
    raw = next;
    loaded = true;
    for (const listener of listeners) listener();
  };

  return {
    getRaw: () => {
      if (!loaded) {
        raw = read();
        loaded = true;
      }
      return raw;
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      // Cross-tab sync: the browser fires `storage` only in *other* same-origin tabs (never the tab
      // that wrote). The event's own payload is used rather than a re-read -- the writing tab has
      // already persisted it, so the payload IS the value, and using it avoids a read-back race.
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key && (legacyKey === undefined || event.key !== legacyKey)) return;
        set(event.newValue);
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(onChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    write: (next) => {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* ignore quota */
      }
      set(next);
    },
    refresh: () => set(read()),
  };
}

/** Server render (and the hydration pass) sees no storage at all, so every key reads as absent. */
const getServerRaw = (): string | null => null;

/** `hydrated` as an external store rather than a `setState` in an effect: it never changes after
 *  mount, so the subscription is a no-op and the two snapshots carry the whole signal. */
const subscribeToHydration = () => () => {};
const isHydrated = () => true;
const isNotHydrated = () => false;

/** An absent key, or one holding something that is not JSON, both read as the initial value. */
function parseRaw<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Tiny SSR-safe localStorage hook. Reads synchronously through `useSyncExternalStore`; writes are
 * persisted immediately and broadcast via a `storage` event for other tabs.
 *
 * `legacyKey`, when given, is read as a one-time fallback if `key` is absent (a rebrand key-rename
 * migration) -- the value found there is written forward to `key` immediately so every later read
 * hits the new key directly. The legacy key is left in place, unremoved.
 *
 * Built on `useSyncExternalStore` rather than `useState` plus a mount effect (#9588). localStorage
 * IS an external store, and subscribing to it directly removes both the mount-time
 * `setState`-in-effect and the render-phase ref write the old shape needed -- and, incidentally,
 * the first-paint flash of the initial value, since the stored value is now available on the very
 * first client render rather than one effect later.
 */
export function useLocalStorage<T>(key: string, initial: T, legacyKey?: string) {
  // The fallback for an absent or unparseable value, captured once. Call sites often pass a fresh
  // `[]` / `{...}` literal each render, and holding the FIRST one is what keeps the identity of the
  // returned value stable across renders. A `useState` initializer rather than a ref: React
  // guarantees it runs exactly once, and reading a ref during render is itself disallowed.
  const [initialValue] = useState(() => initial);

  const cell = useMemo(() => createStorageCell(key, legacyKey), [key, legacyKey]);

  const raw = useSyncExternalStore(cell.subscribe, cell.getRaw, getServerRaw);
  const hydrated = useSyncExternalStore(subscribeToHydration, isHydrated, isNotHydrated);

  const value = useMemo(() => parseRaw(raw, initialValue), [raw, initialValue]);

  // The one-time forward migration. A write is a side effect, so it lives here rather than in the
  // cell's read path; that read path's own legacy fallback means the value is already correct
  // whether or not this has run yet.
  useEffect(() => {
    if (legacyKey === undefined) return;
    try {
      if (window.localStorage.getItem(key) !== null) return;
      const legacyRaw = window.localStorage.getItem(legacyKey);
      if (legacyRaw === null) return;
      window.localStorage.setItem(key, legacyRaw);
      cell.refresh();
    } catch {
      /* ignore */
    }
  }, [cell, key, legacyKey]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      const previous = parseRaw(cell.getRaw(), initialValue);
      const resolved = typeof next === "function" ? (next as (p: T) => T)(previous) : next;
      cell.write(JSON.stringify(resolved));
    },
    [cell, initialValue],
  );

  return [value, update, hydrated] as const;
}
