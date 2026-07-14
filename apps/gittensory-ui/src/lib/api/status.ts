import { useSyncExternalStore } from "react";
import { getApiOrigin } from "./origin";

/**
 * Tiny shared store for global API status.
 * Tracks the live status of the LoopOver API plus an in-flight request count
 * so chrome (HealthDot, top progress bar) can react globally.
 */

export type ApiStatusKind = "idle" | "loading" | "ok" | "timeout" | "unreachable" | "degraded";

export type ConnectionKind = "online" | "offline";

export interface ApiStatusState {
  status: ApiStatusKind;
  lastCheckedAt: number | null;
  lastError: string | null;
  inFlight: number;
  connection: ConnectionKind;
}

const HEALTH_URL = `${getApiOrigin()}/health`;
const HEALTH_TTL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 4_000;

let state: ApiStatusState = {
  status: "idle",
  lastCheckedAt: null,
  lastError: null,
  inFlight: 0,
  connection:
    typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
      ? navigator.onLine
        ? "online"
        : "offline"
      : "online",
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(next: Partial<ApiStatusState>) {
  state = { ...state, ...next };
  emit();
}

export function getApiStatus(): ApiStatusState {
  return state;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const serverSnapshot: ApiStatusState = {
  status: "idle",
  lastCheckedAt: null,
  lastError: null,
  inFlight: 0,
  connection: "online",
};

export function useApiStatus(): ApiStatusState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => serverSnapshot,
  );
}

export function beginRequest() {
  setState({ inFlight: state.inFlight + 1 });
}

export function endRequest() {
  setState({ inFlight: Math.max(0, state.inFlight - 1) });
}

export function reportApiOk() {
  setState({ status: "ok", lastCheckedAt: Date.now(), lastError: null });
}

export function reportApiFailure(
  kind: Exclude<ApiStatusKind, "ok" | "idle" | "loading">,
  error?: string,
) {
  setState({ status: kind, lastCheckedAt: Date.now(), lastError: error ?? null });
}

export function setConnection(c: ConnectionKind) {
  if (state.connection === c) return;
  setState({ connection: c });
}

export function useIsOnline() {
  return useApiStatus().connection === "online";
}

let inFlightHealth: Promise<ApiStatusKind> | null = null;

export async function pingHealth(force = false): Promise<ApiStatusKind> {
  if (typeof window === "undefined") return "idle";
  // If we know we're offline, don't waste a fetch — report unreachable.
  if (state.connection === "offline") {
    reportApiFailure("unreachable", "Browser reports offline");
    return "unreachable";
  }
  if (
    !force &&
    state.lastCheckedAt &&
    Date.now() - state.lastCheckedAt < HEALTH_TTL_MS &&
    state.status !== "idle" &&
    state.status !== "loading"
  ) {
    return state.status;
  }
  if (inFlightHealth) return inFlightHealth;

  setState({ status: state.status === "ok" ? "ok" : "loading" });

  inFlightHealth = (async () => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(HEALTH_URL, { signal: ctrl.signal, cache: "no-store" });
      if (res.ok) {
        reportApiOk();
        return "ok" as ApiStatusKind;
      }
      reportApiFailure("degraded", `${res.status} ${res.statusText}`);
      return "degraded";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      if (isAbort) {
        reportApiFailure("timeout", "Health check timed out");
        return "timeout";
      }
      reportApiFailure("unreachable", msg);
      return "unreachable";
    } finally {
      clearTimeout(timer);
      inFlightHealth = null;
    }
  })();

  return inFlightHealth;
}

export function startHealthPolling() {
  if (typeof window === "undefined") return () => {};
  let cancelled = false;
  let interval: number | null = null;

  const tick = () => {
    if (cancelled) return;
    if (document.visibilityState !== "visible") return;
    void pingHealth();
  };

  void pingHealth(true);
  interval = window.setInterval(tick, HEALTH_TTL_MS);

  const onVis = () => {
    if (document.visibilityState === "visible") tick();
  };
  const onOnline = () => {
    setConnection("online");
    void pingHealth(true);
  };
  const onOffline = () => {
    setConnection("offline");
    reportApiFailure("unreachable", "Browser reports offline");
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  return () => {
    cancelled = true;
    if (interval !== null) clearInterval(interval);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

export function describeApiStatus(s: ApiStatusKind): string {
  switch (s) {
    case "ok":
      return "API healthy";
    case "degraded":
      return "API degraded";
    case "timeout":
      return "API timing out";
    case "unreachable":
      return "API unreachable";
    case "loading":
      return "Checking API…";
    case "idle":
    default:
      return "API status unknown";
  }
}
