// #9143 (defect 5, deploy blocker): resolveOrbWebhookSecret is the fetchBrokeredStoredSecret CALL SITE that
// was missing entirely -- fetchBrokeredStoredSecret (src/orb/broker-client.ts, #8202) had full test coverage
// but zero production callers, so a hosted control-plane tenant container never had any way to obtain its own
// ORB_GITHUB_WEBHOOK_SECRET and would 401 every correctly-signed GitHub delivery forever.
import { beforeEach, describe, expect, it } from "vitest";
import { resetHostedWebhookSecretCacheForTests, resolveOrbWebhookSecret } from "../../src/orb/hosted-webhook-secret";

function captureFetch(handler: (url: string) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return handler(String(url));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  resetHostedWebhookSecretCacheForTests();
});

describe("resolveOrbWebhookSecret", () => {
  it("returns a direct ORB_GITHUB_WEBHOOK_SECRET env value with ZERO network calls (cloud/manual self-host)", async () => {
    const { fetchImpl, calls } = captureFetch(() => {
      throw new Error("fetch should never be called when the direct env value is already set");
    });

    const secret = await resolveOrbWebhookSecret({ ORB_GITHUB_WEBHOOK_SECRET: "whsec_direct" }, fetchImpl);

    expect(secret).toBe("whsec_direct");
    expect(calls).toEqual([]);
  });

  it("returns undefined with no network call when neither the direct secret nor a bootstrap token is set (unconfigured deployment, fail-closed)", async () => {
    const { fetchImpl, calls } = captureFetch(() => {
      throw new Error("fetch should never be called with nothing to bootstrap from");
    });

    const secret = await resolveOrbWebhookSecret({}, fetchImpl);

    expect(secret).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("exchanges LOOPOVER_TENANT_SECRET_TOKEN for the bundled webhook secret via the broker (#9143)", async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      Response.json({ secretValue: JSON.stringify({ database: { host: "h" }, orbWebhookSecret: "whsec_brokered" }), secretType: "tenant_db_credential" }),
    );

    const secret = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "orbsec_tenant" }, fetchImpl);

    expect(secret).toBe("whsec_brokered");
    expect(calls).toEqual(["https://api.loopover.ai/v1/orb/token"]);
  });

  it("caches a successful resolution -- a second call never hits the broker again", async () => {
    const { fetchImpl, calls } = captureFetch(() =>
      Response.json({ secretValue: JSON.stringify({ database: {}, orbWebhookSecret: "whsec_cached" }) }),
    );

    const first = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);
    const second = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);

    expect(first).toBe("whsec_cached");
    expect(second).toBe("whsec_cached");
    expect(calls.length).toBe(1);
  });

  it("de-duplicates concurrent callers into a SINGLE in-flight broker exchange", async () => {
    let resolveResponse!: (value: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const { fetchImpl, calls } = captureFetch(() => pendingResponse);

    const first = resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);
    const second = resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);
    resolveResponse(Response.json({ secretValue: JSON.stringify({ database: {}, orbWebhookSecret: "whsec_concurrent" }) }));

    expect(await first).toBe("whsec_concurrent");
    expect(await second).toBe("whsec_concurrent");
    expect(calls.length).toBe(1);
  });

  it("does NOT cache a failed exchange -- the very next call retries the broker instead of staying wedged (#9143)", async () => {
    let attempt = 0;
    const { fetchImpl } = captureFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("broker down", { status: 503 })
        : Response.json({ secretValue: JSON.stringify({ database: {}, orbWebhookSecret: "whsec_recovered" }) });
    });

    const first = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);
    const second = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);

    expect(first).toBeUndefined(); // fails closed, matching handleOrbWebhook's own convention -- never throws
    expect(second).toBe("whsec_recovered");
    expect(attempt).toBe(2);
  });

  it("resolves to undefined (fails closed) when the bundled payload is not valid JSON", async () => {
    const { fetchImpl } = captureFetch(() => Response.json({ secretValue: "not json at all" }));

    const secret = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);

    expect(secret).toBeUndefined();
  });

  it("resolves to undefined (fails closed) when the bundled payload has no orbWebhookSecret (e.g. an AMS tenant's own bundle)", async () => {
    const { fetchImpl } = captureFetch(() => Response.json({ secretValue: JSON.stringify({ database: { host: "h" } }) }));

    const secret = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);

    expect(secret).toBeUndefined();
  });

  it("resolves to undefined (fails closed) when the bundled orbWebhookSecret is present but not a string", async () => {
    const { fetchImpl } = captureFetch(() => Response.json({ secretValue: JSON.stringify({ orbWebhookSecret: 12345 }) }));

    const secret = await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);

    expect(secret).toBeUndefined();
  });

  it("resolves to undefined (fails closed), never throws, when the broker itself is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    await expect(resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl)).resolves.toBeUndefined();
  });

  it("resolves to undefined (fails closed), never throws, when a non-Error value is thrown (defensive ?? branch)", async () => {
    const fetchImpl = (async () => {
      // Deliberately a non-Error throw, to exercise resolveOrbWebhookSecret's `error instanceof Error ? ... :
      // String(error)` fallback branch.
      throw "not an Error instance";
    }) as typeof fetch;

    await expect(resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl)).resolves.toBeUndefined();
  });

  it("resetHostedWebhookSecretCacheForTests clears a cached value so the NEXT call re-exchanges (test hygiene)", async () => {
    const { fetchImpl, calls } = captureFetch(() => Response.json({ secretValue: JSON.stringify({ orbWebhookSecret: "whsec_a" }) }));
    await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);
    expect(calls.length).toBe(1);

    resetHostedWebhookSecretCacheForTests();

    await resolveOrbWebhookSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "t" }, fetchImpl);
    expect(calls.length).toBe(2);
  });
});
