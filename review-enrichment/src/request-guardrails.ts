import type { EnrichRequest } from "./types.js";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 300;
const MAX_DIFF_BYTES = 1_000_000;
const MAX_TOTAL_PATCH_BYTES = 1_500_000;
const MAX_PATH_CHARS = 1000;
const MAX_ANALYZERS = 100;

export type EnrichRequestParseResult =
  | { ok: true; payload: EnrichRequest; bodyBytes: number }
  | { ok: false; status: 400 | 413; error: string; bodyBytes: number };

export type EnrichRequestBodyReadResult =
  | { ok: true; raw: string; bodyBytes: number }
  | { ok: false; status: 413; error: "request_too_large"; bodyBytes: number };

export async function readEnrichRequestText(request: Request): Promise<EnrichRequestBodyReadResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        error: "request_too_large",
        bodyBytes: parsedLength,
      };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, raw: "", bodyBytes: 0 };

  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bodyBytes += value.byteLength;
      if (bodyBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          status: 413,
          error: "request_too_large",
          bodyBytes,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { ok: true, raw: decodeChunks(chunks, bodyBytes), bodyBytes };
}

export function parseEnrichRequestBody(raw: string): EnrichRequestParseResult {
  const bodyBytes = byteLength(raw);
  if (bodyBytes > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "request_too_large", bodyBytes };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "bad_json", bodyBytes };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "bad_request", bodyBytes };
  }

  const payload = parsed as EnrichRequest;
  if (!validRepo(payload.repoFullName) || !validPullNumber(payload.prNumber)) {
    return { ok: false, status: 400, error: "bad_request", bodyBytes };
  }
  if (payload.files !== undefined && !Array.isArray(payload.files)) {
    return { ok: false, status: 400, error: "bad_files", bodyBytes };
  }
  if ((payload.files?.length ?? 0) > MAX_FILES) {
    return { ok: false, status: 413, error: "too_many_files", bodyBytes };
  }
  if (typeof payload.diff === "string" && byteLength(payload.diff) > MAX_DIFF_BYTES) {
    return { ok: false, status: 413, error: "diff_too_large", bodyBytes };
  }
  if (!validAnalyzers(payload.analyzers)) {
    return { ok: false, status: 400, error: "bad_analyzers", bodyBytes };
  }
  if (!validFiles(payload.files)) {
    return { ok: false, status: 400, error: "bad_files", bodyBytes };
  }
  if (totalPatchBytes(payload.files) > MAX_TOTAL_PATCH_BYTES) {
    return { ok: false, status: 413, error: "patches_too_large", bodyBytes };
  }

  return { ok: true, payload, bodyBytes };
}

function validRepo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    value.length <= 200
  );
}

function validPullNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validAnalyzers(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_ANALYZERS) return false;
  return value.every((entry) => typeof entry === "string" && entry.length <= 80);
}

function validFiles(files: EnrichRequest["files"]): boolean {
  if (!files) return true;
  return files.every((file) => {
    if (!file || typeof file !== "object") return false;
    if (typeof file.path !== "string" || !file.path || file.path.length > MAX_PATH_CHARS) return false;
    if (file.patch !== undefined && typeof file.patch !== "string") return false;
    if (file.status !== undefined && typeof file.status !== "string") return false;
    if (file.previousPath !== undefined && typeof file.previousPath !== "string") return false;
    return true;
  });
}

function totalPatchBytes(files: EnrichRequest["files"]): number {
  return (files ?? []).reduce(
    (total, file) => total + (typeof file.patch === "string" ? byteLength(file.patch) : 0),
    0,
  );
}

function decodeChunks(chunks: readonly Uint8Array[], bodyBytes: number): string {
  const buffer = new Uint8Array(bodyBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
