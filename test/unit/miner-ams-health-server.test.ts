import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import {
  buildHealthBody,
  createAmsHealthHandler,
  readiness,
  startAmsHealthServer,
} from "../../packages/loopover-miner/lib/ams-health-server.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

type CapturedRes = {
  out: { status: number; headers: Record<string, string>; body: string };
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
};

function mockRes(): CapturedRes {
  const out = { status: 0, headers: {} as Record<string, string>, body: "" };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.body = body;
    },
  };
}

const passProbe = (name: string) => ({ name, check: async () => true });
const failProbe = (name: string) => ({ name, check: async () => false });
const throwProbe = (name: string) => ({
  name,
  check: async () => {
    throw new Error("backend unreachable");
  },
});

describe("ams-health-server buildHealthBody / readiness (#7177)", () => {
  it("liveness body is a bare { status: 'ok' }", () => {
    expect(buildHealthBody()).toEqual({ status: "ok" });
  });

  it("readiness with no probes is ok with empty check maps", async () => {
    expect(await readiness()).toEqual({ ok: true, checks: {}, durationsMs: {} });
  });

  it("readiness is ok only when every probe passes, and times each one", async () => {
    const result = await readiness([passProbe("store"), passProbe("loop")]);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({ store: true, loop: true });
    expect(typeof result.durationsMs.store).toBe("number");
    expect(result.durationsMs.loop).toBeGreaterThanOrEqual(0);
  });

  it("readiness fails when any probe returns false or throws (never crashing)", async () => {
    const result = await readiness([passProbe("store"), failProbe("loop"), throwProbe("queue")]);
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual({ store: true, loop: false, queue: false });
    expect(typeof result.durationsMs.queue).toBe("number"); // duration recorded even for the throwing probe
  });
});

describe("ams-health-server request routing (#7177)", () => {
  it("GET /health returns 200 liveness", async () => {
    const res = mockRes();
    await createAmsHealthHandler()({ method: "GET", url: "/health" }, res);
    expect(res.out.status).toBe(200);
    expect(res.out.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.out.body)).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 when probes pass, 503 when they don't", async () => {
    const okRes = mockRes();
    await createAmsHealthHandler([passProbe("store")])({ method: "GET", url: "/ready" }, okRes);
    expect(okRes.out.status).toBe(200);
    expect(JSON.parse(okRes.out.body).ok).toBe(true);

    const degradedRes = mockRes();
    await createAmsHealthHandler([failProbe("store")])({ method: "GET", url: "/ready?verbose=1" }, degradedRes);
    expect(degradedRes.out.status).toBe(503); // query string stripped, still matched /ready
    expect(JSON.parse(degradedRes.out.body).ok).toBe(false);
  });

  it("unknown paths, non-GET methods, and missing urls all 404", async () => {
    const handler = createAmsHealthHandler();
    const unknown = mockRes();
    await handler({ method: "GET", url: "/metrics" }, unknown);
    expect(unknown.out.status).toBe(404);

    const wrongMethod = mockRes();
    await handler({ method: "POST", url: "/health" }, wrongMethod);
    expect(wrongMethod.out.status).toBe(404);

    const noUrl = mockRes();
    await handler({ method: "GET" }, noUrl); // url undefined -> "" -> 404
    expect(noUrl.out.status).toBe(404);
    expect(JSON.parse(noUrl.out.body)).toEqual({ error: "not_found" });
  });
});

describe("ams-health-server listener (#7177)", () => {
  async function base(server: Server) {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  it("serves /health, /ready, and 404s over a real socket on an ephemeral port", async () => {
    const server = await startAmsHealthServer(); // all defaults: port 0, host 0.0.0.0, no probes
    servers.push(server);
    const url = await base(server);

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const ready = await fetch(`${url}/ready`);
    expect(ready.status).toBe(200);

    const missing = await fetch(`${url}/nope`);
    expect(missing.status).toBe(404);
  });

  it("reports 503 over the socket when a wired probe fails", async () => {
    const server = await startAmsHealthServer({ port: 0, host: "127.0.0.1", probes: [failProbe("store")] });
    servers.push(server);
    const ready = await fetch(`${await base(server)}/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { checks: Record<string, boolean> };
    expect(body.checks).toEqual({ store: false });
  });
});
