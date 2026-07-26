// run-agent tenant-quota admission (#7647 hard block + #7662 soft-warning notifications). Evaluated at the
// job-dispatch `run-agent` arm — the single admission-check point for both issues. When a tenant still has
// headroom but is running low, soft warnings are returned for delivery BEFORE executeAgentRun; when blocked,
// the run is failed in place and never executed.

import {
  evaluateTenantQuota,
  evaluateTenantQuotaSoftWarnings,
  type TenantQuota,
  type TenantUsage,
} from "@loopover/engine";
import { getAgentRun, updateAgentRun } from "../db/repositories";
import { quotaWarningEventsForActor } from "../notifications/quota-events";
import type { AgentRunRecord, DetectedNotificationEvent } from "../types";

export type RunAgentTenantQuotaContext = {
  usage: TenantUsage;
  quota: TenantQuota;
};

export type RunAgentQuotaAdmissionDecision = {
  admitted: boolean;
  reason: string | null;
  warningEvents: DetectedNotificationEvent[];
};

export type RunAgentQuotaAdmissionDeps = {
  loadQuotaContext: (env: Env, actorLogin: string) => Promise<RunAgentTenantQuotaContext | null>;
  getRun: (env: Env, runId: string) => Promise<AgentRunRecord | null>;
  failRun: (env: Env, runId: string, reason: string) => Promise<void>;
  detectedAt?: () => string;
};

/** Pure admission decision given already-resolved usage + quota (#7647 / #7662). */
export function decideRunAgentQuotaAdmission(input: {
  actorLogin: string;
  usage: TenantUsage;
  quota: TenantQuota;
  detectedAt?: string;
}): RunAgentQuotaAdmissionDecision {
  const decision = evaluateTenantQuota(input.usage, input.quota);
  const warnings = evaluateTenantQuotaSoftWarnings(decision, input.quota);
  const warningEvents = quotaWarningEventsForActor(input.actorLogin, warnings, input.detectedAt);
  if (!decision.allowed) {
    return { admitted: false, reason: decision.reason, warningEvents: [] };
  }
  return { admitted: true, reason: null, warningEvents };
}

/** Fail-open when no rental-ledger context exists yet (#4792 persistence is a separate concern). */
export async function loadRunAgentTenantQuotaContext(
  _env: Env,
  _actorLogin: string,
): Promise<RunAgentTenantQuotaContext | null> {
  return null;
}

const defaultDeps: RunAgentQuotaAdmissionDeps = {
  loadQuotaContext: loadRunAgentTenantQuotaContext,
  getRun: getAgentRun,
  failRun: async (env, runId, reason) => {
    await updateAgentRun(env, runId, { status: "failed", errorSummary: reason });
  },
};

/**
 * Admission gate for `run-agent` jobs (#7647 / #7662). Returns soft-warning events to deliver before execution
 * and whether the run may proceed. Missing quota context admits without checks until the rental ledger lands.
 */
export async function admitRunAgentJob(
  env: Env,
  runId: string,
  deps: RunAgentQuotaAdmissionDeps = defaultDeps,
): Promise<RunAgentQuotaAdmissionDecision> {
  const run = await deps.getRun(env, runId);
  if (!run) {
    return { admitted: true, reason: null, warningEvents: [] };
  }

  const context = await deps.loadQuotaContext(env, run.actorLogin);
  if (context === null) {
    return { admitted: true, reason: null, warningEvents: [] };
  }

  const detectedAt = deps.detectedAt?.();
  const decision = decideRunAgentQuotaAdmission({
    actorLogin: run.actorLogin,
    usage: context.usage,
    quota: context.quota,
    ...(detectedAt === undefined ? {} : { detectedAt }),
  });

  if (!decision.admitted) {
    if (decision.reason) await deps.failRun(env, runId, decision.reason);
    return decision;
  }

  return decision;
}
