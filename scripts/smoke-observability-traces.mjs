#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const composeService = process.env.SELFHOST_SERVICE ?? "gittensory";
const timeoutMs = Number(process.env.OBSERVABILITY_SMOKE_TIMEOUT_MS ?? "30000");
const pollIntervalMs = Number(
  process.env.OBSERVABILITY_SMOKE_POLL_MS ?? "1000",
);
const traceId = randomBytes(16).toString("hex");
const spanId = randomBytes(8).toString("hex");

await main();

async function main() {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("OBSERVABILITY_SMOKE_TIMEOUT_MS must be a positive number");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0)
    throw new Error("OBSERVABILITY_SMOKE_POLL_MS must be a positive number");

  const script = `
const traceId = ${JSON.stringify(traceId)};
const spanId = ${JSON.stringify(spanId)};
const start = BigInt(Date.now()) * 1000000n;
const body = {
  resourceSpans: [{
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "gittensory-selfhost-smoke" } },
        { key: "deployment.environment.name", value: { stringValue: "selfhost-smoke" } }
      ]
    },
    scopeSpans: [{
      scope: { name: "gittensory-selfhost-smoke" },
      spans: [{
        traceId,
        spanId,
        name: "selfhost.observability.smoke",
        kind: 1,
        startTimeUnixNano: String(start),
        endTimeUnixNano: String(start + 1000000n),
        attributes: [{ key: "smoke.kind", value: { stringValue: "tempo" } }],
        status: { code: 1 }
      }]
    }]
  }]
};
const push = await fetch("http://otel-collector:4318/v1/traces", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
if (!push.ok) throw new Error("collector rejected smoke trace: " + push.status + " " + await push.text());
const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
let last = "";
while (Date.now() <= deadline) {
  const res = await fetch("http://tempo:3200/api/traces/" + traceId);
  if (res.ok) {
    const json = await res.json();
    if (JSON.stringify(json).includes("selfhost.observability.smoke")) {
      console.log(JSON.stringify({ ok: true, traceId }));
      process.exit(0);
    }
    last = "trace response did not contain smoke span";
  } else {
    last = res.status + " " + await res.text();
  }
  await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(pollIntervalMs)}));
}
throw new Error("tempo did not return smoke trace " + traceId + ": " + last.slice(0, 300));
`;

  execFileSync(
    "docker",
    ["compose", "exec", "-T", composeService, "node", "-e", script],
    {
      stdio: "inherit",
    },
  );
}
