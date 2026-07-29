import { useCallback, useEffect, useState } from "react";

import { getApiOrigin } from "./origin";
import { apiFetch, type ApiFailureKind } from "./request";

type ResourceState<T> =
  | { status: "loading"; data: null; error: null; loadedAt: null }
  | { status: "ready"; data: T; error: null; loadedAt: number }
  | {
      status: "error";
      data: null;
      error: string;
      /** Absent for the synthetic "disabled" sentinel below — only real `apiFetch` failures carry one (#793). */
      errorKind?: ApiFailureKind;
      errorStatus?: number;
      loadedAt: null;
    };

/** What a finished load produced. "loading" is not a member: it is the ABSENCE of a settled result for the
 *  inputs currently being asked about, derived at the return below rather than stored. */
type SettledState<T> = Exclude<ResourceState<T>, { status: "loading" }>;

type UseApiResourceOptions = {
  enabled?: boolean;
};

/** The synthetic sentinel a disabled resource reports. Frozen at module scope so every disabled resource
 *  returns the same object rather than a fresh one per render. */
const DISABLED_STATE: ResourceState<never> = Object.freeze({
  status: "error",
  data: null,
  error: "disabled",
  loadedAt: null,
});

const LOADING_STATE: ResourceState<never> = Object.freeze({
  status: "loading",
  data: null,
  error: null,
  loadedAt: null,
});

export function useApiResource<T>(
  path: string,
  label: string,
  token?: string,
  options: UseApiResourceOptions = {},
) {
  const enabled = options.enabled ?? true;

  // The exact inputs a stored result belongs to. Comparing this against the CURRENT inputs is what makes
  // both "loading" and the stale-response guard (#7785) derivable rather than bookkeeping: when `path`
  // changes (pagination offsets, free-text repo input, window selection) a new load starts while an older
  // apiFetch is still in flight, and the older one's result carries the OLD key, so it can neither be
  // reported nor overwrite the newer request's. The request-id ref this replaces did the same job by hand.
  const key = JSON.stringify([path, label, token ?? null]);
  const [settled, setSettled] = useState<{ key: string; state: SettledState<T> } | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const result = await apiFetch<T>(`${getApiOrigin().replace(/\/$/, "")}${path}`, {
      label,
      headers,
      credentials: "include",
    });
    setSettled({
      key,
      state: result.ok
        ? { status: "ready", data: result.data, error: null, loadedAt: Date.now() }
        : {
            status: "error",
            data: null,
            error: result.message,
            errorKind: result.kind,
            errorStatus: result.status,
            loadedAt: null,
          },
    });
  }, [enabled, key, label, path, token]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  /** Explicit refresh. Clears to `loading` first — a caller who asked for a reload wants to see one, and
   *  this runs from an event handler rather than an effect, so nothing cascades. */
  const reload = useCallback(async () => {
    setSettled(null);
    await load();
  }, [load]);

  // Every state here is DERIVED (#9588): nothing is written into state synchronously from an effect, which
  // is what the old shape did twice — once for "disabled" and once for "loading". Storing "disabled" also
  // meant a disabled resource rendered one frame of `loading` before the effect corrected it.
  const state: ResourceState<T> = !enabled
    ? (DISABLED_STATE as ResourceState<T>)
    : settled !== null && settled.key === key
      ? settled.state
      : (LOADING_STATE as ResourceState<T>);

  return { ...state, reload };
}
