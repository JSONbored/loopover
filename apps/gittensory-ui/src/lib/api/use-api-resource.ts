import { useCallback, useEffect, useState } from "react";

import { getApiOrigin } from "./origin";
import { apiFetch } from "./request";

type ResourceState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: null; error: string };

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
  });

  const load = useCallback(async () => {
    if (!enabled) {
      setState({ status: "error", data: null, error: "disabled" });
      return;
    }
    setState({ status: "loading", data: null, error: null });
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const result = await apiFetch<T>(`${getApiOrigin().replace(/\/$/, "")}${path}`, {
      label,
      headers,
    });
    if (result.ok) {
      setState({ status: "ready", data: result.data, error: null });
    } else {
      setState({ status: "error", data: null, error: result.message });
    }
  }, [enabled, label, path, token]);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "error", data: null, error: "disabled" });
      return;
    }
    void load();
  }, [enabled, load]);

  return { ...state, reload: load };
}
