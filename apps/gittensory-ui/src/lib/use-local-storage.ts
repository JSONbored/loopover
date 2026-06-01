import { useCallback, useEffect, useState } from "react";

/**
 * Tiny SSR-safe localStorage hook. Reads once on mount; writes are persisted
 * synchronously and broadcast via a `storage` event for other tabs.
 */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, [key]);

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
