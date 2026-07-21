import { useCallback, useEffect, useRef, useState } from "react";

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

type UseApiResourceOptions = {
  enabled?: boolean;
};

export function useApiResource<T>(
  path: string,
  label: string,
  token?: string,
  options: UseApiResourceOptions = {},
) {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<ResourceState<T>>({
    status: "loading",
    data: null,
    error: null,
    loadedAt: null,
  });

  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    // Guard against out-of-order responses (#7785): when `path` changes (pagination offsets, free-text repo input,
    // window selection) a new load starts while an older apiFetch is still in flight. Tag each load and, after the
    // await, drop the result if a newer load has since superseded it — otherwise a stale page's response resolves
    // last and silently overwrites the current one while the surrounding UI reflects the newer request.
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!enabled) {
      setState({ status: "error", data: null, error: "disabled", loadedAt: null });
      return;
    }
    setState({ status: "loading", data: null, error: null, loadedAt: null });
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const result = await apiFetch<T>(`${getApiOrigin().replace(/\/$/, "")}${path}`, {
      label,
      headers,
      credentials: "include",
    });
    // A newer load superseded this one (the path changed mid-flight); drop this stale response entirely.
    if (requestId !== requestIdRef.current) return;
    if (result.ok) {
      setState({ status: "ready", data: result.data, error: null, loadedAt: Date.now() });
    } else {
      setState({
        status: "error",
        data: null,
        error: result.message,
        errorKind: result.kind,
        errorStatus: result.status,
        loadedAt: null,
      });
    }
  }, [enabled, label, path, token]);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "error", data: null, error: "disabled", loadedAt: null });
      return;
    }
    void load();
  }, [enabled, load]);

  return { ...state, reload: load };
}
