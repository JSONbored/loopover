// Structured audit log for the self-host runtime (#980). Emits one JSON line per job lifecycle event so
// operators can grep / pipe to their log aggregator (Loki, CloudWatch, Datadog, etc.) without any extra
// setup. Written to process.stdout so it is captured by Docker's default json-file log driver and is
// accessible via `docker compose logs gittensory`.
//
// NOT the durable audit_events DB table (#2908): this module is a stdout-only logger for exactly the 4 queue-
// lifecycle events below, called only from sqlite-queue.ts/pg-queue.ts. For the actual queryable audit trail of
// contributor-affecting decisions (review published, PR merged/closed, notification sent/failed, guardrail
// hold, ...), see recordAuditEvent in ../db/repositories.ts.

import { otelTraceLogFields } from "./otel";

export type AuditEventType =
  | "job_complete"
  | "job_dead"
  | "job_error"
  | "job_rate_limited";

export interface AuditEvent {
  event: AuditEventType;
  ts: number;             // Unix timestamp (ms)
  job_id: number | string;
  payload_type?: string | undefined;  // top-level `type` field from the job payload, if present
  repo?: string | undefined;
  pr_number?: number | undefined;
  latency_ms: number;     // wall time from claim to completion/failure
  attempts: number;       // total attempts consumed (1 = first-try success)
  error?: string;         // last error message, present for job_dead / job_error
  retry_after_ms?: number; // next retry delay for job_rate_limited
}

export interface AuditPayloadContext {
  repo?: string | undefined;
  pr_number?: number | undefined;
}

/** Emit a single audit event as a JSON line on stdout. */
export function logAudit(ev: AuditEvent, traceParent?: string): void {
  process.stdout.write(JSON.stringify({ level: "audit", ...ev, ...otelTraceLogFields(traceParent) }) + "\n");
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

/** Extract repo / PR correlation labels from a raw job payload. Only safe scalar fields are returned. */
export function extractPayloadContext(payload: string): AuditPayloadContext | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const repo = extractRepo(parsed);
  const prNumber = extractPrNumber(parsed);
  if (repo === undefined && prNumber === undefined) return undefined;

  const context: AuditPayloadContext = {};
  if (repo !== undefined) context.repo = repo;
  if (prNumber !== undefined) context.pr_number = prNumber;
  return context;
}

function extractRepo(payload: Record<string, unknown>): string | undefined {
  const repoFullName = stringField(payload, "repoFullName");
  if (repoFullName !== undefined) return repoFullName;

  const webhookPayload = recordField(payload, "payload");
  if (webhookPayload === undefined) return undefined;

  const repository = recordField(webhookPayload, "repository");
  if (repository === undefined) return undefined;
  return stringField(repository, "full_name");
}

function extractPrNumber(payload: Record<string, unknown>): number | undefined {
  const prNumber = numberField(payload, "prNumber");
  if (prNumber !== undefined) return prNumber;

  const webhookPayload = recordField(payload, "payload");
  if (webhookPayload === undefined) return undefined;

  const pullRequest = recordField(webhookPayload, "pull_request");
  if (pullRequest !== undefined) {
    const pullRequestNumber = numberField(pullRequest, "number");
    if (pullRequestNumber !== undefined) return pullRequestNumber;
  }

  const issue = recordField(webhookPayload, "issue");
  if (issue !== undefined) {
    const issueNumber = numberField(issue, "number");
    if (issueNumber !== undefined && recordField(issue, "pull_request") !== undefined) return issueNumber;
  }

  const checkRun = recordField(webhookPayload, "check_run");
  if (checkRun !== undefined) {
    const checkRunNumber = firstPullRequestNumber(checkRun);
    if (checkRunNumber !== undefined) return checkRunNumber;
  }

  const checkSuite = recordField(webhookPayload, "check_suite");
  if (checkSuite !== undefined) return firstPullRequestNumber(checkSuite);

  return undefined;
}

function firstPullRequestNumber(record: Record<string, unknown>): number | undefined {
  const pullRequests = record.pull_requests;
  if (!Array.isArray(pullRequests)) return undefined;
  for (const pullRequest of pullRequests) {
    if (!isRecord(pullRequest)) continue;
    const number = numberField(pullRequest, "number");
    if (number !== undefined) return number;
  }
  return undefined;
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = record[field];
  return isRecord(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
