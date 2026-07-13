#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const composeService = process.env.SELFHOST_SERVICE ?? "loopover";
const timeoutMs = Number(process.env.OBSERVABILITY_SMOKE_TIMEOUT_MS ?? "30000");
const pollIntervalMs = Number(
  process.env.OBSERVABILITY_SMOKE_POLL_MS ?? "1000",
);
const metricName = `loopover_selfhost_smoke_${Date.now()}_total`;

await main();

async function main() {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("OBSERVABILITY_SMOKE_TIMEOUT_MS must be a positive number");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0)
    throw new Error("OBSERVABILITY_SMOKE_POLL_MS must be a positive number");

  const script = `
const metricName = ${JSON.stringify(metricName)};
const now = BigInt(Date.now()) * 1000000n;
const body = {
  resourceMetrics: [{
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "loopover-selfhost-smoke" } }
      ]
    },
    scopeMetrics: [{
      scope: { name: "loopover-selfhost-smoke" },
      metrics: [{
        name: metricName,
        sum: {
          dataPoints: [{
            startTimeUnixNano: String(now),
            timeUnixNano: String(now),
            asInt: "1",
            attributes: [{ key: "smoke.kind", value: { stringValue: "metrics" } }]
          }],
          aggregationTemporality: 2,
          isMonotonic: true
        }
      }]
    }]
  }]
};
const push = await fetch("http://otel-collector:4318/v1/metrics", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
if (!push.ok) throw new Error("collector rejected smoke metric: " + push.status + " " + await push.text());
const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
let last = "";
while (Date.now() <= deadline) {
  const res = await fetch("http://otel-collector:8889/metrics");
  if (res.ok) {
    const text = await res.text();
    if (text.includes(metricName)) {
      // Second check: the app's own /metrics is basic-shape sane (real HELP/TYPE lines exist), not just
      // that the process answers 200. Independent of the collector path above -- this is the app's own
      // in-process registry (src/selfhost/metrics.ts), not something the collector could mask a break in.
      const appRes = await fetch("http://localhost:8787/metrics");
      if (!appRes.ok) throw new Error("app /metrics returned " + appRes.status);
      const appText = await appRes.text();
      if (!appText.includes("# HELP loopover_uptime_seconds") || !appText.includes("# TYPE loopover_uptime_seconds gauge")) {
        throw new Error("app /metrics is missing expected HELP/TYPE shape for loopover_uptime_seconds");
      }
      console.log(JSON.stringify({ ok: true, metricName }));
      process.exit(0);
    }
    last = "collector /metrics did not contain the smoke metric yet";
  } else {
    last = res.status + " " + await res.text();
  }
  await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(pollIntervalMs)}));
}
throw new Error("otel-collector did not re-expose smoke metric " + metricName + ": " + last.slice(0, 300));
`;

  execFileSync(
    "docker",
    ["compose", "exec", "-T", composeService, "node", "-e", script],
    {
      stdio: "inherit",
    },
  );
}
