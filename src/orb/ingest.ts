// Gittensory Orb (#1219) — central collector receiver.
// Accepts anonymized outcome signal batches from self-hosted instances running exportOrbBatch.
// No raw repo names, owner identifiers, or PR content is accepted or stored — only HMAC-anonymized
// hashes + aggregate outcome metadata (verdict, timing).

import { verifyGitHubSignature } from "../utils/crypto";

const MAX_BATCH = 500;
export const MAX_ORB_INGEST_BODY_BYTES = 128 * 1024;
const MAX_INSTANCE_ID_CHARS = 64;
const MAX_HASH_CHARS = 128;
const MAX_GATE_VERDICT_CHARS = 64;
const MAX_CREATED_AT_CHARS = 64;
const VALID_OUTCOMES = new Set(["merged", "closed"]);

interface OrbIngestEvent {
  repo_hash: string;
  pr_hash: string;
  outcome: string;
  gate_verdict?: string | null;
  time_to_close_ms?: number | null;
  created_at?: string | null;
}

interface OrbIngestPayload {
  instance_id: string;
  events: OrbIngestEvent[];
}

export type OrbIngestResult = { accepted: number } | { error: string };

export async function verifyOrbIngestSignature(
  body: string,
  signatureHeader: string | null,
  secret: string | undefined,
): Promise<boolean> {
  return verifyGitHubSignature(body, signatureHeader, secret ?? "");
}

export async function readOrbIngestBody(request: Request, contentLengthHeader: string | null | undefined): Promise<string | null> {
  const contentLength = parsePositiveInt(contentLengthHeader);
  if (contentLength !== null && contentLength > MAX_ORB_INGEST_BODY_BYTES) return null;

  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_ORB_INGEST_BODY_BYTES) return null;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function handleOrbIngest(body: string, db: D1Database): Promise<OrbIngestResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { error: "invalid_json" };
  }

  if (
    typeof (payload as OrbIngestPayload)?.instance_id !== "string" ||
    !Array.isArray((payload as OrbIngestPayload)?.events)
  ) {
    return { error: "invalid_payload" };
  }

  const { instance_id, events } = payload as OrbIngestPayload;
  if (!isBoundedString(instance_id, MAX_INSTANCE_ID_CHARS) || events.length === 0) {
    return { error: "invalid_payload" };
  }

  const batch = events.slice(0, MAX_BATCH);
  let accepted = 0;

  for (const event of batch) {
    if (
      !isBoundedString(event.repo_hash, MAX_HASH_CHARS) ||
      !isBoundedString(event.pr_hash, MAX_HASH_CHARS) ||
      !VALID_OUTCOMES.has(event.outcome)
    ) {
      continue;
    }

    const gateVerdict = normalizeOptionalString(event.gate_verdict, MAX_GATE_VERDICT_CHARS);
    const sentAt = normalizeOptionalString(event.created_at, MAX_CREATED_AT_CHARS);
    if (gateVerdict === undefined || sentAt === undefined) continue;

    try {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO orb_signals
           (instance_id, repo_hash, pr_hash, outcome, gate_verdict, time_to_close_ms, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          instance_id,
          event.repo_hash,
          event.pr_hash,
          event.outcome,
          gateVerdict,
          typeof event.time_to_close_ms === "number" ? event.time_to_close_ms : null,
          sentAt,
        )
        .run();
      if (result.meta.changes > 0) accepted++;
    } catch {
      // best-effort — skip rows that violate constraints or hit transient errors
    }
  }

  return { accepted };
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function normalizeOptionalString(value: unknown, maxChars: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxChars) return undefined;
  return value;
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}
