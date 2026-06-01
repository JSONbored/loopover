import { createElement, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  beginRequest,
  describeApiStatus,
  endRequest,
  getApiStatus,
  pingHealth,
  reportApiFailure,
  reportApiOk,
  type ApiStatusKind,
} from "./status";

export type ApiFailureKind = "timeout" | "network" | "http";

export type ApiResult<T> =
  | { ok: true; data: T; status: number; durationMs: number }
  | {
      ok: false;
      kind: ApiFailureKind;
      status?: number;
      message: string;
      durationMs: number;
    };

interface ApiFetchOptions extends RequestInit {
  /** Human-readable label for toasts ("MCP version", "GitHub stats"). */
  label: string;
  /** Timeout in ms (default 8000). */
  timeoutMs?: number;
  /** Parser; defaults to res.json() when 2xx with JSON body, else res.text(). */
  parse?: (res: Response) => Promise<unknown>;
  /** Suppress global status updates (e.g. for the health probe itself). */
  silentStatus?: boolean;
}

async function defaultParse(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (/(application|text)\/(json|.*\+json)/i.test(ct)) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return res.text();
}

export async function apiFetch<T = unknown>(
  input: RequestInfo | URL,
  opts: ApiFetchOptions,
): Promise<ApiResult<T>> {
  const { label: _label, timeoutMs = 8000, parse = defaultParse, silentStatus, ...init } = opts;
  const ctrl = new AbortController();
  const timer =
    typeof window !== "undefined" ? window.setTimeout(() => ctrl.abort(), timeoutMs) : null;

  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  beginRequest();
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    const data = (await parse(res)) as T;
    const durationMs = Math.round(
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
    );
    if (!res.ok) {
      if (!silentStatus) reportApiFailure("degraded", `${res.status} ${res.statusText}`);
      return {
        ok: false,
        kind: "http",
        status: res.status,
        message: `${res.status} ${res.statusText}`,
        durationMs,
      };
    }
    if (!silentStatus) reportApiOk();
    return { ok: true, data, status: res.status, durationMs };
  } catch (e) {
    const durationMs = Math.round(
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
    );
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    if (isAbort) {
      if (!silentStatus) reportApiFailure("timeout", "Request timed out");
      return { ok: false, kind: "timeout", message: "Request timed out", durationMs };
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (!silentStatus) reportApiFailure("unreachable", msg);
    return { ok: false, kind: "network", message: msg, durationMs };
  } finally {
    if (timer !== null) clearTimeout(timer);
    endRequest();
  }
}

function failureTitle(kind: ApiFailureKind, status?: number) {
  if (kind === "timeout") return "Request timed out";
  if (kind === "network") return "API unreachable";
  if (kind === "http" && status && status >= 500) return `API degraded (${status})`;
  if (kind === "http" && status) return `Request failed (${status})`;
  return "Request failed";
}

/**
 * Show a single, label-scoped toast for an API failure with a Retry button.
 * Subsequent failures with the same label dedupe by toast id.
 */
export function notifyApiFailure(args: {
  label: string;
  kind: ApiFailureKind;
  status?: number;
  message?: string;
  retry?: () => void | Promise<void>;
  /** Timeout (ms) to display in the Retry countdown. Default 8000. */
  retryTimeoutMs?: number;
}) {
  const { label, kind, status, message, retry, retryTimeoutMs = 8000 } = args;
  const id = `api:${label}`;
  const apiStatus = getApiStatus().status;

  const now = Date.now();
  const prev = notifierState.get(id);
  const sameKind = prev && prev.kind === kind && prev.status === status;
  const recent = prev && now - prev.lastNotifiedAt < 5000;
  const repeatCount = sameKind && recent ? prev.repeatCount + 1 : 1;

  notifierState.set(id, { kind, status, lastNotifiedAt: now, repeatCount, retrying: false });

  const statusLabel =
    apiStatus !== "ok" && apiStatus !== "idle" ? describeApiStatus(apiStatus) : null;

  const baseDesc = [label, message, statusLabel].filter(Boolean).join(" · ");
  const desc =
    repeatCount > 1 ? `${baseDesc} · still failing (${repeatCount}× in a row)` : baseDesc;

  toast.error(failureTitle(kind, status), {
    id,
    description: desc,
    duration: 8000,
    action: retry
      ? {
          label: "Retry",
          onClick: () => runRetryWithProgress(id, label, retry, retryTimeoutMs),
        }
      : undefined,
  });
}

export function notifyApiRecovered(label: string) {
  const id = `api:${label}`;
  notifierState.delete(id);
  toast.success("Recovered", {
    id,
    description: `${label} is responding again.`,
    duration: 2500,
  });
}

// ---------------------------------------------------------------------------
// Dedupe state + retry-with-progress
// ---------------------------------------------------------------------------

interface NotifierEntry {
  kind: ApiFailureKind;
  status?: number;
  lastNotifiedAt: number;
  repeatCount: number;
  retrying: boolean;
}

const notifierState = new Map<string, NotifierEntry>();

function runRetryWithProgress(
  id: string,
  label: string,
  retry: () => void | Promise<void>,
  timeoutMs: number,
) {
  const entry = notifierState.get(id);
  if (entry?.retrying) return; // already in flight — ignore further clicks
  if (entry) entry.retrying = true;

  const startedAt = Date.now();
  toast.loading("Retrying…", {
    id,
    description: createElement(RetryCountdown, { label, startedAt, timeoutMs }),
    duration: timeoutMs + 1000,
  });

  void pingHealth(true);

  Promise.resolve()
    .then(() => retry())
    .then(() => {
      // If caller did not explicitly toast success/failure, dismiss the loading
      // toast. notifyApiRecovered / notifyApiFailure will replace by id otherwise.
      const stale = notifierState.get(id);
      if (stale && stale.lastNotifiedAt <= startedAt) {
        notifierState.delete(id);
        toast.dismiss(id);
      }
    })
    .catch(() => {
      // Caller surface will fire notifyApiFailure again, which replaces the toast.
    })
    .finally(() => {
      const e = notifierState.get(id);
      if (e) e.retrying = false;
    });
}

function RetryCountdown({
  label,
  startedAt,
  timeoutMs,
}: {
  label: string;
  startedAt: number;
  timeoutMs: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(i);
  }, []);
  const elapsed = Math.min(now - startedAt, timeoutMs);
  const remaining = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
  const pct = Math.min(100, Math.round((elapsed / timeoutMs) * 100));
  return createElement(
    "span",
    { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 180 } },
    createElement(
      "span",
      { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } },
      createElement("span", null, label),
      createElement("span", { style: { fontVariantNumeric: "tabular-nums" } }, `${remaining}s`),
    ),
    createElement(
      "span",
      {
        "aria-hidden": true,
        style: {
          display: "block",
          height: 2,
          width: "100%",
          background: "var(--muted, rgba(255,255,255,0.08))",
          borderRadius: 2,
          overflow: "hidden",
        },
      },
      createElement("span", {
        style: {
          display: "block",
          height: "100%",
          width: `${pct}%`,
          background: "var(--mint, currentColor)",
          transition: "width 250ms linear",
        },
      }),
    ),
  );
}
