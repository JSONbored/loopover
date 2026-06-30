import type { AnalyzerDiagnostics } from "./types.js";

export type BoundedFetchFailureReason =
  | "aborted"
  | "timeout"
  | "network_error"
  | "http_error"
  | "response_too_large"
  | "invalid_json"
  | "call_cap";

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
      const result = failure(endpointCategory, "http_error", startedAtMs, null, status);
      attachDiagnostics(result, options);
      return result;
    }

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
      timedOut || controller.signal.aborted ? (timedOut ? "timeout" : "aborted") : "network_error";
    const result = failure(endpointCategory, reason, startedAtMs, null);
    attachDiagnostics(result, options);
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
      const result = failure(endpointCategory, "http_error", startedAtMs, null, status);
      attachDiagnostics(result, options);
      return result;
    }

    const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_JSON_BYTES));
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
      return result;
    }

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
      timedOut || controller.signal.aborted ? (timedOut ? "timeout" : "aborted") : "network_error";
    const result = failure(endpointCategory, reason, startedAtMs, null);
    attachDiagnostics(result, options);
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
