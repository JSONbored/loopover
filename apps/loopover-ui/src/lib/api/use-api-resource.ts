import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

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

/** The synthetic sentinel a disabled resource reports, distinguishing "switched off" from a real
 *  `apiFetch` failure that happens to share the `status: "error"` shape. Exported so call sites that
 *  need to tell the two apart compare against this instead of a bare string literal (#9672). */
export const API_RESOURCE_DISABLED = "disabled";

/** Frozen at module scope so every disabled resource returns the same object rather than a fresh one
 *  per render. */
const DISABLED_STATE: ResourceState<never> = Object.freeze({
  status: "error",
  data: null,
  error: API_RESOURCE_DISABLED,
  loadedAt: null,
});

const LOADING_STATE: ResourceState<never> = Object.freeze({
  status: "loading",
  data: null,
  error: null,
  loadedAt: null,
});

/** Carries `apiFetch`'s structured failure through react-query's error channel, which only speaks throws. */
class ApiResourceError extends Error {
  constructor(
    message: string,
    readonly kind: ApiFailureKind,
    readonly httpStatus: number | undefined,
  ) {
    super(message);
    this.name = "ApiResourceError";
  }
}

/**
 * Reads one API resource into the loading/ready/error shape every panel in this app renders.
 *
 * Backed by react-query (#9588) rather than a hand-rolled effect + state machine. The app already runs a
 * QueryClient at the root, so this removes the second, parallel data layer -- and with it the effect that
 * called setState on mount, the manual request-id guard against out-of-order responses, and the bespoke
 * reload plumbing, all of which the library does correctly by keying on the request.
 *
 * The three options below are set EXPLICITLY, not inherited: react-query's defaults retry three times and
 * refetch on window focus, neither of which this hook did. Pinning them means adopting the library changes
 * no observable behaviour at any of its call sites; loosening them is a deliberate per-surface decision,
 * not a side effect of this refactor.
 */
export function useApiResource<T>(
  path: string,
  label: string,
  token?: string,
  options: UseApiResourceOptions = {},
) {
  const enabled = options.enabled ?? true;

  const query = useQuery<T, ApiResourceError>({
    queryKey: ["api-resource", path, label, token ?? null],
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
    queryFn: async () => {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const result = await apiFetch<T>(`${getApiOrigin().replace(/\/$/, "")}${path}`, {
        label,
        headers,
        credentials: "include",
      });
      if (!result.ok) throw new ApiResourceError(result.message, result.kind, result.status);
      return result.data;
    },
  });

  const reload = useCallback(async () => {
    await query.refetch();
  }, [query]);

  // Every branch is DERIVED from the query -- nothing is written into state from an effect (#9588).
  const state: ResourceState<T> = !enabled
    ? (DISABLED_STATE as ResourceState<T>)
    : query.isSuccess
      ? { status: "ready", data: query.data, error: null, loadedAt: query.dataUpdatedAt }
      : query.isError
        ? {
            status: "error",
            data: null,
            error: query.error.message,
            errorKind: query.error.kind,
            errorStatus: query.error.httpStatus,
            loadedAt: null,
          }
        : (LOADING_STATE as ResourceState<T>);

  return { ...state, reload };
}
