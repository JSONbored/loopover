import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ORB_BROKER_URL,
  ORB_BROKER_TIMEOUT_MS,
  fetchBrokeredStoredSecret,
  orbBrokerBaseUrl,
} from "@loopover/contract/orb-broker";

// #9521: src/orb/broker-client.ts and packages/loopover-miner/lib/tenant-credential-resolution.ts both
// used to own a copy of this. The copies had already drifted on the local-host list, in a function whose
// entire job is deciding where a bootstrap credential may be sent -- so it is pinned here directly.

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
}

describe("orbBrokerBaseUrl", () => {
  it("defaults to the hosted broker when ORB_BROKER_URL is unset", () => {
    expect(orbBrokerBaseUrl({})).toBe(DEFAULT_ORB_BROKER_URL);
  });

  it("returns the bare origin for a root-path URL, with no trailing slash", () => {
    expect(orbBrokerBaseUrl({ ORB_BROKER_URL: "https://broker.example/" })).toBe("https://broker.example");
  });

  it("keeps a path prefix, stripped of trailing slashes", () => {
    expect(orbBrokerBaseUrl({ ORB_BROKER_URL: "https://broker.example/api//" })).toBe("https://broker.example/api");
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])("allows plaintext %s for local development", (url) => {
    expect(orbBrokerBaseUrl({ ORB_BROKER_URL: url })).toBe(url);
  });

  it.each([
    ["a non-URL", "not a url", "must be a valid URL"],
    ["embedded userinfo", "https://user:pass@broker.example", "must not include userinfo"],
    ["a username alone", "https://user@broker.example", "must not include userinfo"],
    ["a query string", "https://broker.example/?a=1", "must not include a query string or fragment"],
    ["a fragment", "https://broker.example/#frag", "must not include a query string or fragment"],
    ["plaintext to a remote host", "http://broker.example", "must use https unless it targets localhost"],
    // #8334: a WHATWG URL brackets IPv6, so a bare ::1 is not the loopback spelling and must not pass.
    ["a non-loopback host that merely looks local", "http://localhost.evil.example", "must use https unless it targets localhost"],
  ])("rejects %s", (_label, url, message) => {
    expect(() => orbBrokerBaseUrl({ ORB_BROKER_URL: url })).toThrow(message);
  });
});

describe("fetchBrokeredStoredSecret", () => {
  it("exchanges the bootstrap token at POST /v1/orb/token and returns the custodied secret", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secretValue: "postgres://…", secretType: "tenant_db_credential" }));
    const secret = await fetchBrokeredStoredSecret(
      { LOOPOVER_TENANT_SECRET_TOKEN: "boot_tok", ORB_BROKER_URL: "https://broker.example" },
      fetchImpl as unknown as typeof fetch,
    );

    expect(secret).toEqual({ secretValue: "postgres://…", secretType: "tenant_db_credential" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://broker.example/v1/orb/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer boot_tok");
  });

  it("defaults secretType to an empty string when the broker omits it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secretValue: "v" }));
    await expect(fetchBrokeredStoredSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      secretValue: "v",
      secretType: "",
    });
  });

  it("sends an empty bearer rather than the string 'undefined' when no token is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secretValue: "v", secretType: "t" }));
    await fetchBrokeredStoredSecret({}, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ");
  });

  it("throws with the status on a non-OK exchange, leaking no body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "enrollment revoked" }, { status: 403 }));
    await expect(fetchBrokeredStoredSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "Orb broker stored-secret exchange failed (403).",
    );
  });

  it("throws when a 200 body carries no secretValue", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secretType: "tenant_db_credential" }));
    await expect(fetchBrokeredStoredSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "did not include a secretValue",
    );
  });

  it("bounds the exchange with the shared broker timeout", () => {
    // A cold mint can take many seconds when GitHub is throttling the App; the value is the contract.
    expect(ORB_BROKER_TIMEOUT_MS).toBe(25_000);
  });
});
