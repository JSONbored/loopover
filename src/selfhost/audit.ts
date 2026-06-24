// Structured audit log for the self-host runtime (#980). Emits one JSON line per job lifecycle event so
// operators can grep / pipe to their log aggregator (Loki, CloudWatch, Datadog, etc.) without any extra
// setup. Written to process.stdout so it is captured by Docker's default json-file log driver and is
// accessible via `docker compose logs gittensory`.

export type AuditEventType = "job_complete" | "job_dead" | "job_error";

export interface AuditEvent {
  event: AuditEventType;
  ts: number;             // Unix timestamp (ms)
  job_id: number | string;
  payload_type?: string | undefined;  // top-level `type` field from the job payload, if present
  latency_ms: number;     // wall time from claim to completion/failure
  attempts: number;       // total attempts consumed (1 = first-try success)
  error?: string;         // last error message, present for job_dead / job_error
}

/** Emit a single audit event as a JSON line on stdout. */
export function logAudit(ev: AuditEvent): void {
  process.stdout.write(JSON.stringify({ level: "audit", ...ev }) + "\n");
}

/** Extract a `type` label from a raw job payload string without fully parsing it. Returns undefined
 *  if the payload is not a JSON object or lacks a top-level `type` string. */
export function extractPayloadType(payload: string): string | undefined {
  try {
    const o = JSON.parse(payload) as Record<string, unknown>;
    return typeof o.type === "string" ? o.type : undefined;
  } catch {
    return undefined;
  }
}
