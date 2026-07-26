// Wire the ported Discord anomaly-alerter (src/review/alerts.ts) into the host cron. alerts.ts is a
// self-contained, dependency-injected port: it computes no snapshots itself, so the host builds the
// operator agent-config from env and injects the native ops-port health/calibration snapshots
// (src/review/ops.ts — the same pair operator-dashboard already reads). Runs on the SAME cron tick as
// runOpsAlerts so the Discord channel fires alongside the structured-log + PagerDuty path (#8905).
//
// FAILS SAFE: an alerting side-channel must never break the cron. Unlike runOpsAlerts' pure reads,
// runAnomalyAlerts writes throttle-claim rows, so a storage error is possible; a top-level error is
// swallowed to a structured log, mirroring runOpsAlerts' own "never throws into the queue" contract.
import { runAnomalyAlerts, type AlertAgentConfig, type AnomalyAlertDeps } from "./alerts";
import { computeAgentHealth, computeCalibration } from "./ops";

/**
 * Build the operator agent-config, inject the native health/calibration snapshots, and fire the Discord
 * anomaly alert. No-op unless a valid DISCORD_WEBHOOK_URL is configured — runAnomalyAlerts self-gates on
 * the webhook before any storage write, so an operator who has not wired a channel pays nothing.
 *
 * Caller invokes this only from the flag-ON ops cron path (alongside runOpsAlerts), so flag-OFF it is
 * never reached and the cron does zero new work.
 */
export async function runAnomalyAlertsWired(env: Env): Promise<void> {
  // The same slug fallback operator-dashboard / api routes use to key this deployment's review_targets rows.
  const slug = env.GITHUB_APP_SLUG?.trim() || "loopover";
  const config: AlertAgentConfig = {
    slug,
    // discordNotify is always ON here; the REAL gate is the webhook — resolveWebhook returns "" when
    // DISCORD_WEBHOOK_URL is unset and runAnomalyAlerts then returns before touching storage.
    features: { discordNotify: true },
    secrets: { discordWebhook: "DISCORD_WEBHOOK_URL" },
  };
  const deps: AnomalyAlertDeps = {
    computeAgentHealth: (alertEnv, alertConfig) => computeAgentHealth(alertEnv, { slug: alertConfig.slug, secrets: {} }),
    computeCalibration: (alertEnv, alertConfig) => computeCalibration(alertEnv, { slug: alertConfig.slug, secrets: {} }),
  };
  try {
    await runAnomalyAlerts(env, config, deps);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "anomaly_alert_wire_error", message: String(error).slice(0, 200) }));
  }
}
