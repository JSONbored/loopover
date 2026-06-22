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

  it("reports missing on an unparseable 200 body (json().catch → null payload, line 94)", async () => {
    // A 200 with a body that is not valid JSON → res.json() throws → .catch(() => null) → !payload → missing.
    const f = (async () =>
      new Response("<<<not json>>>", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect((await fetchSubnetRecord({}, 6, f)).status).toBe("missing");
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

  it("returns null (fail-open) when the key is set but no row matches the netuid", async () => {
    const f = jsonFetch([{ match: "taostats", body: { data: [{ netuid: 99, subnet_name: "Other" }] } }]);
    expect(await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "secret" }, 14, f)).toBeNull();
  });

  it("returns null (fail-open) for a non-integer netuid even with a key", async () => {
    const f = jsonFetch([{ match: "taostats", body: { data: [{ netuid: 14, subnet_name: "X" }] } }]);
    expect(await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "secret" }, 1.5, f)).toBeNull();
  });

  it("falls back to summary when description is absent + drops blank strings", async () => {
    const f = jsonFetch([
      {
        match: "taostats",
        body: { data: [{ netuid: 14, subnet_name: "   ", github_repo: "", subnet_url: "https://x.ai", summary: "from summary" }] },
      },
    ]);
    const id = await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "secret" }, 14, f);
    expect(id).toMatchObject({ netuid: 14, name: null, github: null, url: "https://x.ai", description: "from summary" });
  });

  it("returns null when the body is not valid JSON (json().catch → empty rows)", async () => {
    const f = (async () => new Response("<<<not json>>>", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    // payload?.data is undefined → rows [] → no row → null. Drives the json().catch + empty-rows path.
    expect(await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "secret" }, 14, f)).toBeNull();
  });

  it("fails open to null when the fetch itself throws (line 176 outer catch)", async () => {
    const f = (async () => {
      throw new Error("network exploded"); // fetchWithRetry exhausts retries + re-throws → outer try/catch
    }) as unknown as typeof fetch;
    expect(await fetchTaostatsSubnetIdentity({ TAOSTATS_API_KEY: "secret" }, 14, f)).toBeNull();
  });
});

describe("fetchWithRetry behavior (via fetchSubnetRecord)", () => {
  it("retries a thrown fetch error then succeeds (covers the catch + backoff retry path, lines 61-63)", async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient network");
      return new Response(JSON.stringify({ data: { subnet: { netuid: 3, name: "Recovered" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const r = await fetchSubnetRecord({}, 3, f);
    expect(calls).toBe(2); // first threw, second succeeded
    expect(r.status).toBe("exists");
    expect(r.record).toMatchObject({ name: "Recovered" });
  });

  it("exhausts retries on a persistent thrown error → caught as 'error' (covers the final throw, line 65)", async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      throw new Error("always down");
    }) as unknown as typeof fetch;
    const r = await fetchSubnetRecord({}, 7, f);
    expect(r.status).toBe("error"); // fetchWithRetry re-throws lastError → fetchSubnetRecord catch
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("re-throws a non-Error rejection as a generic Error (line 65 fallback)", async () => {
    const f = (async () => {
      throw "string failure"; // non-Error throw
    }) as unknown as typeof fetch;
    // The non-Error branch of `lastError instanceof Error ? ... : new Error(...)` is taken, then caught → error.
    const r = await fetchSubnetRecord({}, 8, f);
    expect(r.status).toBe("error");
  });
});

describe("fetchSubnetRecord — array-shaped data envelope", () => {
  it("reports exists from a non-empty array data envelope (line 103)", async () => {
    const f = jsonFetch([{ match: "/subnets/22", body: { data: [{ netuid: 22, name: "ArrShape" }] } }]);
    const r = await fetchSubnetRecord({}, 22, f);
    expect(r.status).toBe("exists");
    expect(r.record).toMatchObject({ name: "ArrShape" });
  });

  it("reports missing from an empty array data envelope", async () => {
    const f = jsonFetch([{ match: "/subnets/23", body: { data: [] } }]);
    expect((await fetchSubnetRecord({}, 23, f)).status).toBe("missing");
  });

  it("reports exists with a null record from a [null]-element array envelope (data[0] ?? null fallback, line 104)", async () => {
    // length > 0 but the first element is null → the `data[0] ?? null` fallback yields null.
    const f = jsonFetch([{ match: "/subnets/24", body: { data: [null] } }]);
    const r = await fetchSubnetRecord({}, 24, f);
    expect(r.status).toBe("exists");
    expect(r.record).toBeNull();
  });
});

describe("fetchSubnetRecord — object data envelope shape edges", () => {
  it("falls back to the whole payload when there is no `data` key (data ?? payload, line 100)", async () => {
    // No `data` envelope: `payload.data` is undefined → `?? payload` uses the top-level object,
    // which echoes the netuid → exists.
    const f = jsonFetch([{ match: "/subnets/30", body: { netuid: 30, name: "TopLevel" } }]);
    const r = await fetchSubnetRecord({}, 30, f);
    expect(r.status).toBe("exists");
    expect(r.record).toMatchObject({ name: "TopLevel" });
  });

  it("reports missing when `data` is a non-object scalar (typeof data !== 'object', line 101)", async () => {
    // `payload.data` is a truthy non-object → `data` is a string → fails the object guard.
    const f = jsonFetch([{ match: "/subnets/31", body: { data: "not an object" } }]);
    expect((await fetchSubnetRecord({}, 31, f)).status).toBe("missing");
  });

  it("reports missing on a nested error envelope inside `data` (\"error\" in data, line 107)", async () => {
    // Top-level payload has no `error`, but the nested `data` object does → missing.
    const f = jsonFetch([{ match: "/subnets/32", body: { data: { error: "nested not found" } } }]);
    expect((await fetchSubnetRecord({}, 32, f)).status).toBe("missing");
  });

  it("reports missing when the record neither echoes the netuid nor carries known fields (line 115 both sides)", async () => {
    // data is a real object (no error key, no subnet), but its netuid mismatches the query and it
    // has none of the recordFields → !echoesNetuid && !hasRecordFields → missing.
    const f = jsonFetch([{ match: "/subnets/14", body: { data: { netuid: 999, unrelated: "junk" } } }]);
    expect((await fetchSubnetRecord({}, 14, f)).status).toBe("missing");
  });

  it("reports exists when the netuid echoes even without record fields (echoesNetuid short-circuits line 115)", async () => {
    // echoesNetuid true → !echoesNetuid false → the && does NOT evaluate the right side; exists.
    const f = jsonFetch([{ match: "/subnets/15", body: { data: { netuid: 15 } } }]);
    const r = await fetchSubnetRecord({}, 15, f);
    expect(r.status).toBe("exists");
    expect(r.record).toMatchObject({ netuid: 15 });
  });

  it("reports exists via a record field even when the netuid does not echo (hasRecordFields side, line 115)", async () => {
    // echoesNetuid false (mismatched netuid) but a known recordField present → !hasRecordFields false → exists.
    const f = jsonFetch([{ match: "/subnets/16", body: { data: { netuid: 777, owner: "0xabc" } } }]);
    const r = await fetchSubnetRecord({}, 16, f);
    expect(r.status).toBe("exists");
    expect(r.record).toMatchObject({ owner: "0xabc" });
  });
});
