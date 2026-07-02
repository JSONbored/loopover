import type { AnalyzerDiagnostics } from "./types.js";

export type BoundedFetchFailureReason =
  | "aborted"
  | "timeout"
  | "network_error"
  | "http_error"
  | "response_too_large"
  | "invalid_json"
  | "call_cap"
  | "circuit_open";

export interface BoundedFetchOk<T> {
  ok: true;
  status: number;
  data: T;
  bytes: number | null;
  elapsedMs: number;
  endpointCategory: string;
}

export interface BoundedFetchFailure {
  ok: false;
  status?: number;
  reason: BoundedFetchFailureReason;
  bytes: number | null;
  elapsedMs: number;
  endpointCategory: string;
  capped?: boolean;
}

export type BoundedFetchResult<T> = BoundedFetchOk<T> | BoundedFetchFailure;

export interface BoundedFetchOptions {
  endpointCategory: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  diagnostics?: AnalyzerDiagnostics;
  phase?: string;
  subcall?: string;
}

const DEFAULT_EXTERNAL_TIMEOUT_MS = 1200;
const DEFAULT_MAX_JSON_BYTES = 512 * 1024;

export function safeEndpointCategory(category: string): string {
  const safe = category.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
  return safe || "unknown";
}

// Circuit breaker: once an endpointCategory racks up enough consecutive
// remote-health failures, short-circuit further calls for a cooldown window
// instead of re-attempting a currently-unhealthy endpoint from a cold state.
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const circuits = new Map<string, { failures: number; cooldownUntil: number }>();

export function resetExternalFetchCircuitBreakerForTest(): void {
  circuits.clear();
}

function isCircuitOpen(endpointCategory: string): boolean {
  const circuit = circuits.get(endpointCategory);
  return circuit !== undefined && circuit.cooldownUntil > Date.now();
}

function recordCircuitFailure(endpointCategory: string): void {
  // Always read the map fresh at call time (never accept a pre-captured
  // circuit object or close over a variable read earlier in the caller
  // before an await) so concurrent calls for the same endpointCategory
  // can't race on a stale read. The read+set here has no await between
  // them, so this function's own write is race-free by construction.
  const circuit = circuits.get(endpointCategory) ?? {
    failures: 0,
    cooldownUntil: 0,
  };
  const failures = circuit.failures + 1;
  const cooldownUntil =
    failures >= CIRCUIT_FAILURE_THRESHOLD
      ? Date.now() + CIRCUIT_COOLDOWN_MS
      : circuit.cooldownUntil;
  circuits.set(endpointCategory, { failures, cooldownUntil });
}

function recordCircuitSuccess(endpointCategory: string): void {
  circuits.delete(endpointCategory);
}

// Not every failure reason should trip the breaker. A plain 404 (or any
// other non-{403,429,5xx} http_error) is often a LEGITIMATE negative
// business result, not a sign the remote service is unhealthy — e.g.
// typosquat.ts calls boundedFetchStatus for many candidate package names
// where a 404 just means "this typo-squat candidate doesn't exist," which
// is the analyzer working correctly, not a failure worth circuit-breaking
// on. Similarly "aborted" is always CALLER-driven (either the caller's
// signal was already aborted before the call started, or a parent signal
// cancelled mid-flight) — never a signal about the remote service's own
// health — so it must never count. "response_too_large" and "invalid_json"
// mean the remote DID respond, just unexpectedly, so they don't count
// either. Only "timeout", "network_error", and http_error with status
// 403/429/5xx (auth/rate-limit/server-error — genuinely indicates the
// remote is unhealthy or blocking us) should trip the breaker. This
// mirrors shouldMarkDegraded's distinction below but is intentionally MORE
// NARROW — shouldMarkDegraded answers "should the caller's diagnostics be
// marked partial" (broader, includes aborted/response_too_large), this
// answers "does this failure indicate the REMOTE SERVICE is unhealthy"
// (narrower); do not conflate the two or reuse shouldMarkDegraded here.
function isRemoteHealthFailure(result: BoundedFetchFailure): boolean {
  if (result.reason === "timeout" || result.reason === "network_error")
    return true;
  if (result.reason === "http_error") {
    const status = result.status ?? 0;
    return status === 403 || status === 429 || status >= 500;
  }
  return false;
}

export function externalFetchCacheKey(
  url: string,
  options: Pick<BoundedFetchOptions, "method" | "body"> = {},
): string {
  const method = (options.method ?? "GET").toUpperCase();
  return `${method}:${url}:body:${hashBody(options.body)}`;
}

export async function boundedFetchJson<T>(
  url: string,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult<T>> {
  const text = await boundedFetchText(url, options);
  if (!text.ok) return text;
  try {
    return {
      ...text,
      data: JSON.parse(text.data) as T,
    };
  } catch {
    const result = failure(
      text.endpointCategory,
      "invalid_json",
      Date.now() - text.elapsedMs,
      text.bytes,
      text.status,
    );
    attachDiagnostics(result, options);
    return result;
  }
}

export async function boundedFetchStatus(
  url: string,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult<null>> {
  const endpointCategory = safeEndpointCategory(options.endpointCategory);
  const startedAtMs = Date.now();
  if (isCircuitOpen(endpointCategory)) {
    const result: BoundedFetchFailure = {
      ok: false,
      reason: "circuit_open",
      bytes: null,
      elapsedMs: 0,
      endpointCategory,
    };
    attachDiagnostics(result, options);
    return result;
  }
  const signal = options.signal;
  if (signal?.aborted) {
    const result = failure(endpointCategory, "aborted", startedAtMs, null);
    attachDiagnostics(result, options);
    return result;
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS),
  );
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? "HEAD",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const status = response.status;
    if (!response.ok) {
      const result = failure(
        endpointCategory,
        "http_error",
        startedAtMs,
        null,
        status,
      );
      attachDiagnostics(result, options);
      if (isRemoteHealthFailure(result)) recordCircuitFailure(endpointCategory);
      return result;
    }

    recordCircuitSuccess(endpointCategory);
    return {
      ok: true,
      status,
      data: null,
      bytes: null,
      elapsedMs: Date.now() - startedAtMs,
      endpointCategory,
    };
  } catch {
    const reason =
      timedOut || controller.signal.aborted
        ? timedOut
          ? "timeout"
          : "aborted"
        : "network_error";
    const result = failure(endpointCategory, reason, startedAtMs, null);
    attachDiagnostics(result, options);
    if (isRemoteHealthFailure(result)) recordCircuitFailure(endpointCategory);
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function boundedFetchText(
  url: string,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult<string>> {
  const endpointCategory = safeEndpointCategory(options.endpointCategory);
  const startedAtMs = Date.now();
  if (isCircuitOpen(endpointCategory)) {
    const result: BoundedFetchFailure = {
      ok: false,
      reason: "circuit_open",
      bytes: null,
      elapsedMs: 0,
      endpointCategory,
    };
    attachDiagnostics(result, options);
    return result;
  }
  const signal = options.signal;
  if (signal?.aborted) {
    const result = failure(endpointCategory, "aborted", startedAtMs, null);
    attachDiagnostics(result, options);
    return result;
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS),
  );
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const status = response.status;
    if (!response.ok) {
      const result = failure(
        endpointCategory,
        "http_error",
        startedAtMs,
        null,
        status,
      );
      attachDiagnostics(result, options);
      if (isRemoteHealthFailure(result)) recordCircuitFailure(endpointCategory);
      return result;
    }

    const maxBytes = Math.max(
      1,
      Math.floor(options.maxBytes ?? DEFAULT_MAX_JSON_BYTES),
    );
    const text = await readResponseText(response, maxBytes);
    if (text === null) {
      const result = failure(
        endpointCategory,
        "response_too_large",
        startedAtMs,
        null,
        status,
        true,
      );
      attachDiagnostics(result, options);
      if (isRemoteHealthFailure(result)) recordCircuitFailure(endpointCategory);
      return result;
    }

    recordCircuitSuccess(endpointCategory);
    return {
      ok: true,
      status,
      data: text,
      bytes: byteLength(text),
      elapsedMs: Date.now() - startedAtMs,
      endpointCategory,
    };
  } catch {
    const reason =
      timedOut || controller.signal.aborted
        ? timedOut
          ? "timeout"
          : "aborted"
        : "network_error";
    const result = failure(endpointCategory, reason, startedAtMs, null);
    attachDiagnostics(result, options);
    if (isRemoteHealthFailure(result)) recordCircuitFailure(endpointCategory);
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function failure(
  endpointCategory: string,
  reason: BoundedFetchFailureReason,
  startedAtMs: number,
  bytes: number | null,
  status?: number,
  capped = false,
): BoundedFetchFailure {
  return {
    ok: false,
    ...(status !== undefined ? { status } : {}),
    reason,
    bytes,
    elapsedMs: Date.now() - startedAtMs,
    endpointCategory,
    ...(capped ? { capped: true } : {}),
  };
}

function attachDiagnostics(
  result: BoundedFetchFailure,
  options: BoundedFetchOptions,
): void {
  const diagnostics = options.diagnostics;
  if (!diagnostics || !shouldMarkDegraded(result)) return;
  diagnostics.partialStatus = "partial";
  diagnostics.partialReason ??= `${result.endpointCategory}_${result.reason}`;
  diagnostics.captureDegradation = true;
  diagnostics.endpointCategory = result.endpointCategory;
  diagnostics.externalFailureReason = result.reason;
  diagnostics.externalElapsedMs = result.elapsedMs;
  if (result.capped) diagnostics.capped = true;
  if (result.endpointCategory.startsWith("github-")) {
    diagnostics.githubEndpointCategory = result.endpointCategory;
  }
  if (options.phase) diagnostics.phase = options.phase;
  diagnostics.subcall = options.subcall ?? result.endpointCategory;
}

function shouldMarkDegraded(result: BoundedFetchFailure): boolean {
  if (result.reason !== "http_error") return true;
  const status = result.status ?? 0;
  return status === 403 || status === 429 || status >= 500;
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const contentLength = response.headers?.get("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) return null;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text =
      typeof response.text === "function"
        ? await response.text()
        : typeof response.json === "function"
          ? JSON.stringify(await response.json())
          : "";
    return byteLength(text) > maxBytes ? null : text;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function hashBody(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) return "none";
  if (typeof body === "string") return `${body.length}:${fnv1a(body)}`;
  return "stream";
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
