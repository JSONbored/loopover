import { describe, expect, it } from "vitest";
import {
  checkNetuidExists,
  fetchSubnetRecord,
  fetchTaostatsSubnetIdentity,
} from "../../src/review/content-lane/netuid-verification";

/** A fetch stub mapping a URL substring → a JSON body + status. */
function jsonFetch(routes: Array<{ match: string; status?: number; body?: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("", { status: 404 });
    const status = route.status ?? 200;
    const body = route.body === undefined ? "" : JSON.stringify(route.body);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("fetchSubnetRecord (public registry — no API key)", () => {
  it("reports exists + returns the identity record for a real subnet", async () => {
    const f = jsonFetch([{ match: "/subnets/14", body: { data: { subnet: { netuid: 14, name: "Cacheon" } } } }]);
    const r = await fetchSubnetRecord({}, 14, f);
    expect(r.status).toBe("exists");
    expect(r.record).toMatchObject({ name: "Cacheon" });
  });

  it("reports missing on a 404", async () => {
    const f = jsonFetch([{ match: "/subnets/999", status: 404 }]);
    expect((await fetchSubnetRecord({}, 999, f)).status).toBe("missing");
  });

  it("reports missing on a 200 error-envelope (unknown id answered with {error})", async () => {
    const f = jsonFetch([{ match: "/subnets/5", body: { error: "not found" } }]);
    expect((await fetchSubnetRecord({}, 5, f)).status).toBe("missing");
  });

  it("fails SAFE to error on a 500 (→ manual upstream)", async () => {
    const f = jsonFetch([{ match: "/subnets/14", status: 500 }]);
    // 500 is retried then surfaces as error (fail-safe).
    expect((await fetchSubnetRecord({}, 14, f)).status).toBe("error");
  });

  it("honors a METAGRAPHED_PUBLIC_API_BASE override", async () => {
    let seen = "";
    const f = (async (input: RequestInfo | URL) => {
      seen = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ data: { subnet: { netuid: 1, name: "X" } } }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchSubnetRecord({ METAGRAPHED_PUBLIC_API_BASE: "https://registry.internal/api" }, 1, f);
    expect(seen).toBe("https://registry.internal/api/subnets/1");
  });

  it("checkNetuidExists is the status-only wrapper", async () => {
    const f = jsonFetch([{ match: "/subnets/14", body: { data: { netuid: 14 } } }]);
    expect(await checkNetuidExists({}, 14, f)).toBe("exists");
  });
});

describe("fetchTaostatsSubnetIdentity (key-gated, fail-open)", () => {
  it("returns null when TAOSTATS_API_KEY is unset (the lane falls back to other signals)", async () => {
    const f = jsonFetch([{ match: "taostats", body: { data: [{ netuid: 14, subnet_name: "Cacheon" }] } }]);
    expect(await fetchTaostatsSubnetIdentity({}, 14, f)).toBeNull();
  });

  it("returns the on-chain identity when the key is set + the row matches", async () => {
    const f = jsonFetch([
      {
        match: "taostats",
        body: { data: [{ netuid: 14, subnet_name: "Cacheon", github_repo: "https://github.com/cacheon/x", subnet_url: "https://cacheon.ai", description: "desc" }] },
      },
    ]);
    const id = await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "secret" }, 14, f);
    expect(id).toMatchObject({ netuid: 14, name: "Cacheon", github: "https://github.com/cacheon/x", url: "https://cacheon.ai" });
  });

  it("sends the key as a RAW Authorization header (not Bearer)", async () => {
    let auth: string | null = null;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [{ netuid: 9, subnet_name: "N" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "rawkey123" }, 9, f);
    expect(auth).toBe("rawkey123");
  });

  it("fails open to null on an upstream error", async () => {
    const f = jsonFetch([{ match: "taostats", status: 500 }]);
    expect(await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "secret" }, 14, f)).toBeNull();
  });
});
