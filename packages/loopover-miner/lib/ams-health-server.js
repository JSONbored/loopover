import { createServer } from "node:http";

// Minimal HTTP health surface for a hosted AMS container (#7177). AMS is otherwise CLI-only (loopover-miner
// status/doctor) and the operator UI reads its SQLite files directly -- but a hosted control-plane polling
// container health across a fleet (#4933/#4934) needs each container to answer over HTTP. This deliberately
// mirrors ORB's src/selfhost/health.ts SHAPE -- `/health` -> `{ status: "ok" }` liveness, `/ready` -> a
// `{ ok, checks, durationsMs }` readiness built from injectable ReadinessProbes -- so the same aggregator can
// poll both products identically. It runs ONLY from the hosted-container entry point; the self-host CLI never
// starts it, so self-host behavior is unchanged. No HTTP framework dependency: node:http is enough for two routes.

/** @typedef {{ name: string, check: () => Promise<boolean> }} ReadinessProbe */

/** Bare liveness body: the process is up and answering, independent of any backend it depends on. */
export function buildHealthBody() {
  return { status: "ok" };
}

/**
 * Readiness: run every injected probe and report per-probe pass/fail plus how long each took. `ok` is true only
 * when every probe passed -- a container that can't reach a backend it depends on must stop reporting ready so
 * the fleet aggregator can route around it. A probe that throws counts as failed (never crashes readiness), and
 * its duration is still recorded. Mirrors src/selfhost/health.ts's `readiness`/`timedReadinessCheck` behavior.
 *
 * @param {ReadinessProbe[]} [probes]
 * @returns {Promise<{ ok: boolean, checks: Record<string, boolean>, durationsMs: Record<string, number> }>}
 */
export async function readiness(probes = []) {
  const checks = {};
  const durationsMs = {};
  let ok = true;
  for (const probe of probes) {
    const startedAt = performance.now();
    let passed = false;
    try {
      passed = (await probe.check()) === true;
    } catch {
      passed = false;
    } finally {
      durationsMs[probe.name] = Math.max(0, performance.now() - startedAt);
    }
    checks[probe.name] = passed;
    if (!passed) ok = false;
  }
  return { ok, checks, durationsMs };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/**
 * Build the request handler for the AMS health surface: `GET /health` -> 200 liveness, `GET /ready` -> 200/503
 * readiness (503 when any probe fails, so a load balancer stops routing to a degraded container), anything else
 * -> 404. Exported separately from {@link startAmsHealthServer} so it can be exercised without binding a socket.
 *
 * @param {ReadinessProbe[]} [probes]
 */
export function createAmsHealthHandler(probes = []) {
  return async (req, res) => {
    const path = (req.url ?? "").split("?", 1)[0];
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, buildHealthBody());
      return;
    }
    if (req.method === "GET" && path === "/ready") {
      const result = await readiness(probes);
      sendJson(res, result.ok ? 200 : 503, result);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  };
}

/**
 * Start the AMS health HTTP server. Resolves once it is listening. `port: 0` binds an ephemeral port (the caller
 * reads `server.address()`), which is what the tests use. The hosted-container entry point owns the lifecycle and
 * passes the AMS-specific probes (store reachable, loop cycle alive); the returned server is closed on shutdown.
 *
 * @param {{ port?: number, host?: string, probes?: ReadinessProbe[] }} [options]
 * @returns {Promise<import("node:http").Server>}
 */
export function startAmsHealthServer(options = {}) {
  const port = Number.isInteger(options.port) ? options.port : 0;
  const host = typeof options.host === "string" && options.host ? options.host : "0.0.0.0";
  const probes = Array.isArray(options.probes) ? options.probes : [];
  const server = createServer(createAmsHealthHandler(probes));
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
