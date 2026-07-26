// Rent-a-Loop quota soft-warning notification bridge (#7662). Pure builders for DetectedNotificationEvent rows
// that run-agent admission feeds into evaluateNotificationEvent → notify-deliver — the same path job-dispatch.ts
// uses for webhook-detected kinds. No parallel delivery store.

import type { QuotaDimension, QuotaSoftWarning, QuotaSoftWarningSeverity } from "@loopover/engine";
import type { DetectedNotificationEvent } from "../types";
import { nowIso } from "../utils/json";

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function dimensionLabel(dimension: QuotaDimension): string {
  switch (dimension) {
    case "compute":
      return "compute units";
    case "time":
      return "wall-clock time";
    case "concurrency":
      return "concurrent loops";
  }
}

/** Public-safe copy for a quota soft-warning badge notification (#7662). */
export function buildTenantQuotaWarningNotification(input: {
  warning: QuotaSoftWarning;
}): { title: string; body: string } {
  const label = dimensionLabel(input.warning.dimension);
  const urgency = input.warning.severity === "critical" ? "critically low" : "running low";
  return {
    title: `Quota ${urgency}: ${label}`,
    body: `You have ${input.warning.remaining} of ${input.warning.cap} ${label} remaining in your current allocation. Increase your allocation or pace your loops before a hard block stops new runs.`,
  };
}

/**
 * Build a quota soft-warning event. Not repo-scoped — `repoFullName` is a stable synthetic scope
 * (`rent-a-loop/quota`); `pullNumber` is 0.
 */
export function buildTenantQuotaWarningEvent(input: {
  recipientLogin: string;
  warning: QuotaSoftWarning;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  const { warning } = input;
  return {
    eventType: "tenant_quota_warning",
    recipientLogin,
    repoFullName: "rent-a-loop/quota",
    pullNumber: 0,
    dedupKey: `tenant_quota_warning:${recipientLogin}:${warning.dimension}:${warning.severity}:${warning.remaining}:${warning.cap}`,
    deeplink: "https://github.com/JSONbored/loopover",
    actorLogin: recipientLogin,
    detectedAt,
  };
}

export function quotaWarningEventsForActor(
  actorLogin: string,
  warnings: readonly QuotaSoftWarning[],
  detectedAt?: string,
): DetectedNotificationEvent[] {
  return warnings.map((warning) =>
    buildTenantQuotaWarningEvent({
      recipientLogin: actorLogin,
      warning,
      ...(detectedAt === undefined ? {} : { detectedAt }),
    }),
  );
}

/** Decode the warning embedded in a tenant_quota_warning dedupKey; null when malformed. */
export function parseTenantQuotaWarningDedupKey(dedupKey: string): QuotaSoftWarning | null {
  const parts = dedupKey.split(":");
  if (parts.length !== 6 || parts[0] !== "tenant_quota_warning") return null;
  const dimension = parts[2];
  const severity = parts[3];
  const remaining = Number(parts[4]);
  const cap = Number(parts[5]);
  if (dimension !== "compute" && dimension !== "time" && dimension !== "concurrency") return null;
  if (!isQuotaSoftWarningSeverity(severity)) return null;
  if (!Number.isFinite(remaining) || !Number.isFinite(cap)) return null;
  return { dimension, severity, remaining, cap };
}

export function isQuotaSoftWarningSeverity(value: unknown): value is QuotaSoftWarningSeverity {
  return value === "low" || value === "critical";
}
