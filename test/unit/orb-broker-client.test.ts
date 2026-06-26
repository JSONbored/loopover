import { describe, expect, it } from "vitest";
import { fetchBrokeredInstallationToken, isOrbBrokerMode, registerOrbRelayTarget } from "../../src/orb/broker-client";

/** A fetch stub that records the URL + init and returns a fixed response. */
function captureFetch(resp: Response): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit | undefined }[] } {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return resp;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("isOrbBrokerMode", () => {
  it("is on only when an enrollment secret is configured", () => {
    expect(isOrbBrokerMode({})).toBe(false);
    expect(isOrbBrokerMode({ ORB_ENROLLMENT_SECRET: "orbsec_x" })).toBe(true);
  });
});

describe("fetchBrokeredInstallationToken", () => {
  it("exchanges the secret for a token + parses the expiry (default broker URL + Bearer secret)", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "ghs_x", installationId: 42, expiresAt: "2026-06-25T09:00:00Z" }));
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "orbsec_x" }, fetchImpl);
    expect(out).toEqual({ token: "ghs_x", installationId: 42, expiresAtMs: Date.parse("2026-06-25T09:00:00Z") });
    expect(calls[0]?.url).toBe("https://gittensory-api.aethereal.dev/v1/orb/token");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer orbsec_x");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("defaults installationId + expiry when absent, and strips a trailing slash from a custom broker URL", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "ghs_y" }));
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://broker.example/" }, fetchImpl);
    expect(out.token).toBe("ghs_y");
    expect(out.installationId).toBe(0); // payload.installationId ?? 0
    expect(out.expiresAtMs).toBeGreaterThan(Date.now()); // payload.expiresAt absent → ~50min default
    expect(calls[0]?.url).toBe("https://broker.example/v1/orb/token");
  });

  it("sends an empty Bearer when no secret is set (defensive ?? branch)", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "t" }));
    await fetchBrokeredInstallationToken({}, fetchImpl);
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer ");
  });

  it("rejects broker URLs that would send the enrollment secret to unsafe origins", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch should not be called for an unsafe broker URL");
    }) as typeof fetch;

    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "http://broker.example" }, fetchImpl)).rejects.toThrow(/must use https/);
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://user:pass@broker.example" }, fetchImpl)).rejects.toThrow(/userinfo/);
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://:pass@broker.example" }, fetchImpl)).rejects.toThrow(/userinfo/);
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://broker.example?redirect=evil" }, fetchImpl)).rejects.toThrow(/query string or fragment/);
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://broker.example#token" }, fetchImpl)).rejects.toThrow(/query string or fragment/);
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "not a url" }, fetchImpl)).rejects.toThrow(/valid URL/);
  });

  it("allows explicit localhost HTTP broker URLs for development only", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ token: "ghs_local" });
    }) as typeof fetch;

    await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "http://127.0.0.1:8787" }, fetchImpl);
    await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "http://[::1]:8787" }, fetchImpl);
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "http://localhost:8787/orb/" }, fetchImpl);

    expect(out.token).toBe("ghs_local");
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8787/v1/orb/token",
      "http://[::1]:8787/v1/orb/token",
      "http://localhost:8787/orb/v1/orb/token",
    ]);
  });

  it("throws on a non-OK broker response (e.g. 403 installation_not_eligible)", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s" }, fetchImpl)).rejects.toThrow(/403/);
  });

  it("throws when the broker response has no token", async () => {
    const fetchImpl = (async () => Response.json({ installationId: 1 })) as typeof fetch;
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s" }, fetchImpl)).rejects.toThrow(/did not include a token/);
  });
});

describe("registerOrbRelayTarget", () => {
  it("skips unless broker mode AND a public origin are configured", async () => {
    expect(await registerOrbRelayTarget({})).toBe("skipped"); // not broker mode
    expect(await registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "s" })).toBe("skipped"); // no PUBLIC_API_ORIGIN
  });

  it("POSTs the relay URL (origin + /v1/orb/relay) to the broker with the enrollment secret; trailing slashes stripped", async () => {
    const { fetchImpl, calls } = captureFetch(new Response("ok"));
    expect(await registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "orbsec_x", PUBLIC_API_ORIGIN: "https://me.example/", ORB_BROKER_URL: "https://broker.example/" }, fetchImpl)).toBe("registered");
    expect(calls[0]?.url).toBe("https://broker.example/v1/orb/relay/register"); // ORB_BROKER_URL trailing slash stripped
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer orbsec_x");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ relayUrl: "https://me.example/v1/orb/relay" }); // PUBLIC_API_ORIGIN trailing slash stripped
  });

  it("uses the default broker base when ORB_BROKER_URL is unset", async () => {
    const { fetchImpl, calls } = captureFetch(new Response("ok"));
    await registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" }, fetchImpl);
    expect(calls[0]?.url).toBe("https://gittensory-api.aethereal.dev/v1/orb/relay/register");
  });

  it("fails closed without registering when the broker URL is unsafe", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch should not be called for an unsafe broker URL");
    }) as typeof fetch;

    await expect(registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example", ORB_BROKER_URL: "http://broker.example" }, fetchImpl)).resolves.toBe("failed");
  });

  it("returns failed on a non-ok response or a thrown fetch (never blocks boot)", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    expect(await registerOrbRelayTarget(cfg, (async () => new Response("no", { status: 403 })) as typeof fetch)).toBe("failed");
    expect(await registerOrbRelayTarget(cfg, (async () => { throw new Error("down"); }) as typeof fetch)).toBe("failed");
  });
});
