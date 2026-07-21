// Mirrors ORB's `triggerPagerDutyIncident` (src/services/notify-pagerduty.ts) Events API v2 contract exactly:
// same LOOPOVER_ENABLE_PAGERDUTY flag, same PAGERDUTY_ROUTING_KEY, same events.pagerduty.com enqueue URL, same
// dedup_key/custom_details shape (#7667). control-plane is a plain Node package with no Worker Env/D1 binding
// (#7524) -- there is no hosted call site to import `triggerPagerDutyIncident` into, and no D1-backed audit log
// or cooldown here, the same reasoning #7666's miner-side mirror (packages/loopover-miner/lib/governor-kill-switch.ts)
// used for AMS kill-switch trips. PagerDuty's own `dedup_key` still coalesces duplicate incidents. Best-effort:
// never throws -- a paging failure must never block or mask the underlying provisioning failure it is reporting.

const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
// PagerDuty routing/integration keys are 32 lowercase hex characters.
const ROUTING_KEY_RE = /^[a-f0-9]{32}$/i;
const TRUTHY_ENV = /^(1|true|yes|on)$/i;

export type PagerDutySeverity = "critical" | "error" | "warning" | "info";

/** A pure PagerDuty alert payload for a provisioning-lifecycle failure. `phase` keeps a provision failure and a
 *  deprovision failure paging as separate incidents (distinct dedup_key) even for the same tenant. */
export type ProvisioningPagerDutyAlert = {
  tenantName: string;
  product: string;
  phase: "provision" | "deprovision";
  summary: string;
  severity: PagerDutySeverity;
  dedupKey: string;
  customDetails: Record<string, unknown>;
};

export type NotifyProvisioningFailure = (
  alert: ProvisioningPagerDutyAlert,
  env: Record<string, string | undefined>,
) => void | Promise<void>;

function envString(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Prefer `Error.message` when present; otherwise coerce. Exported so provisioning.ts's own notify-failure
 *  warn log (a paging failure, not a provisioning failure) coerces the same way as every failure path in this
 *  module, instead of a second ad hoc `String(error)` copy. */
export function pagerDutyFailMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function warnProvisioningPagerDutyFailed(tenantName: string, error: unknown): void {
  console.warn(
    JSON.stringify({ event: "provisioning_pagerduty_failed", tenant: tenantName, message: pagerDutyFailMessage(error) }),
  );
}

/** Build the alert payload for a provisioning or deprovisioning failure (#7667). Pure -- no IO. `error` is
 *  coerced through the same {@link pagerDutyFailMessage} helper the IO path uses for its own failure logging, so
 *  the paged summary and any local warn log agree on the same truncated message. */
export function buildProvisioningPagerDutyAlert(input: {
  tenantName: string;
  product: string;
  phase: "provision" | "deprovision";
  error: unknown;
}): ProvisioningPagerDutyAlert {
  const message = pagerDutyFailMessage(input.error);
  return {
    tenantName: input.tenantName,
    product: input.product,
    phase: input.phase,
    summary: `${input.product} tenant ${input.phase} failed for ${input.tenantName}: ${message}`,
    severity: "critical",
    dedupKey: `control_plane_${input.phase}_failed:${input.product}:${input.tenantName}`,
    customDetails: { tenantName: input.tenantName, product: input.product, phase: input.phase, message },
  };
}

/** Miner/AMS-style mirror of `triggerPagerDutyIncident` (#7667, same contract as #7666): same flag, same global
 *  routing key, same Events API v2 enqueue. No D1 audit/cooldown (control-plane has no Worker Env) -- PagerDuty's
 *  own `dedup_key` still coalesces duplicate incidents. Best-effort: never throws. */
export async function notifyProvisioningFailure(
  alert: ProvisioningPagerDutyAlert,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!TRUTHY_ENV.test((env.LOOPOVER_ENABLE_PAGERDUTY ?? "").trim())) return;
  const routingKey = envString(env, "PAGERDUTY_ROUTING_KEY");
  if (!routingKey || !ROUTING_KEY_RE.test(routingKey)) return;

  try {
    const response = await fetch(PAGERDUTY_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: "trigger",
        dedup_key: alert.dedupKey,
        payload: {
          summary: alert.summary.slice(0, 1024),
          source: "loopover-control-plane",
          severity: alert.severity,
          timestamp: new Date().toISOString(),
          component: alert.tenantName,
          custom_details: alert.customDetails,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(
        JSON.stringify({ event: "provisioning_pagerduty_failed", tenant: alert.tenantName, status: response.status }),
      );
    }
  } catch (error) {
    warnProvisioningPagerDutyFailed(alert.tenantName, error);
  }
}
