import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tiny SSR-safe localStorage hook. Reads once on mount; writes are persisted
 * synchronously and broadcast via a `storage` event for other tabs.
 *
 * `legacyKey`, when given, is read as a one-time fallback if `key` is absent
 * (a rebrand key-rename migration) -- the value found there is written
 * forward to `key` immediately so every later read hits the new key
 * directly. The legacy key is left in place, unremoved.
 */
export function useLocalStorage<T>(key: string, initial: T, legacyKey?: string) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  // Call sites often pass a fresh `[]` / `{...}` literal each render; keep the
  // listener keyed only on `key`/`legacyKey` and read the latest initial via ref.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        setValue(JSON.parse(raw) as T);
      } else if (legacyKey) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (legacyRaw !== null) {
          setValue(JSON.parse(legacyRaw) as T);
          window.localStorage.setItem(key, legacyRaw);
        }
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);

    // Cross-tab sync: the browser fires `storage` only in *other* same-origin tabs
    // (never the tab that wrote). Same-tab writes already update state via `update()`.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && (!legacyKey || event.key !== legacyKey)) return;
      if (event.newValue === null) {
        setValue(initialRef.current);
        return;
      }
      try {
        setValue(JSON.parse(event.newValue) as T);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, legacyKey]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* ignore quota */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, update, hydrated] as const;
}
