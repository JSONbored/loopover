import { describe, expect, it, vi } from "vitest";
import { counterValue, resetMetrics } from "../../src/selfhost/metrics";
import {
  createOrbRelayRegistrationState,
  drainOrbRelay,
  fetchBrokeredInstallationToken,
  isOrbBrokerMode,
  ORB_RELAY_REGISTER_RETRY_BACKOFF_MS,
  ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK,
  registerOrbRelayTarget,
  registerOrbRelayTargetWithRetry,
} from "../../src/orb/broker-client";

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
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "ghs_x", installationId: 42, expiresAt: "2026-06-25T09:00:00Z", permissions: { contents: "write" } }));
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "orbsec_x" }, fetchImpl);
    expect(out).toEqual({ token: "ghs_x", installationId: 42, expiresAtMs: Date.parse("2026-06-25T09:00:00Z"), permissions: { contents: "write" } });
    expect(calls[0]?.url).toBe("https://gittensory-api.aethereal.dev/v1/orb/token");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer orbsec_x");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("asks the broker to force-refresh when retrying a stale permission scope", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "ghs_x", installationId: 42, expiresAt: "2026-06-25T09:00:00Z" }));
    await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "orbsec_x" }, fetchImpl, { forceRefresh: true });
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ forceRefresh: true });
  });

  it("defaults installationId + expiry when absent, and strips a trailing slash from a custom broker URL", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "ghs_y" }));
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://broker.example/" }, fetchImpl);
    expect(out.token).toBe("ghs_y");
    expect(out.installationId).toBe(0); // payload.installationId ?? 0
    expect(out.permissions).toEqual({});
    expect(out.expiresAtMs).toBeGreaterThan(Date.now()); // payload.expiresAt absent → ~50min default
    expect(calls[0]?.url).toBe("https://broker.example/v1/orb/token");
  });

  it("falls back to the ~50min default when expiresAt is present but unparseable (no NaN into the token cache)", async () => {
    const { fetchImpl } = captureFetch(Response.json({ token: "ghs_z", installationId: 7, expiresAt: "not-a-date" }));
    const before = Date.now();
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s" }, fetchImpl);
    expect(Number.isFinite(out.expiresAtMs)).toBe(true); // a malformed expiry must not poison the cache with NaN
    expect(out.expiresAtMs).toBeGreaterThanOrEqual(before + 49 * 60_000);
    expect(out.token).toBe("ghs_z");
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
    expect(await registerOrbRelayTarget({})).toEqual({ status: "skipped" }); // not broker mode
    expect(await registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "s" })).toEqual({ status: "skipped" }); // no PUBLIC_API_ORIGIN
  });

  it("POSTs the relay URL (origin + /v1/orb/relay) to the broker with the enrollment secret; trailing slashes stripped", async () => {
    const { fetchImpl, calls } = captureFetch(new Response("ok"));
    expect(await registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "orbsec_x", PUBLIC_API_ORIGIN: "https://me.example/", ORB_BROKER_URL: "https://broker.example/" }, fetchImpl)).toEqual({ status: "registered" });
    expect(calls[0]?.url).toBe("https://broker.example/v1/orb/relay/register"); // ORB_BROKER_URL trailing slash stripped
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer orbsec_x");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ relayUrl: "https://me.example/v1/orb/relay", mode: "push" }); // PUBLIC_API_ORIGIN trailing slash stripped
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

    await expect(registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example", ORB_BROKER_URL: "http://broker.example" }, fetchImpl)).resolves.toMatchObject({ status: "failed" });
  });

  it("returns failed on a non-ok response or a thrown fetch (never blocks boot)", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    expect(await registerOrbRelayTarget(cfg, (async () => new Response("no", { status: 403 })) as typeof fetch)).toEqual({ status: "failed", reason: "http_403" });
    expect(await registerOrbRelayTarget(cfg, (async () => { throw new Error("down"); }) as typeof fetch)).toEqual({ status: "failed", reason: "down" });
  });

  it("pull mode (ORB_RELAY_MODE=pull) registers with NO relay URL and works without a public origin (NAT/tailnet)", async () => {
    const { fetchImpl, calls } = captureFetch(new Response("ok"));
    // No PUBLIC_API_ORIGIN — push would skip, but pull doesn't need an inbound URL.
    expect(await registerOrbRelayTarget({ ORB_ENROLLMENT_SECRET: "s", ORB_RELAY_MODE: "pull" }, fetchImpl)).toEqual({ status: "registered" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ relayUrl: "", mode: "pull" });
  });

  it("surfaces a sanitized error/message hint from a JSON failure body without leaking raw bytes", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    const errBody = (async () => Response.json({ error: "database unavailable" }, { status: 500 })) as typeof fetch;
    expect(await registerOrbRelayTarget(cfg, errBody)).toEqual({ status: "failed", reason: "http_500: database unavailable" });

    const messageBody = (async () =>
      new Response(JSON.stringify({ message: "install not found" }), {
        status: 404,
        headers: { "content-length": "31", "content-type": "application/json" },
      })) as typeof fetch;
    expect(await registerOrbRelayTarget(cfg, messageBody)).toEqual({ status: "failed", reason: "http_404: install not found" });
  });

  it("falls back to the bare status when the failure body is not JSON or has no error/message string", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    expect(await registerOrbRelayTarget(cfg, (async () => new Response("", { status: 502 })) as typeof fetch)).toEqual({ status: "failed", reason: "http_502" });
    expect(await registerOrbRelayTarget(cfg, (async () => new Response("<html>gateway error</html>", { status: 502 })) as typeof fetch)).toEqual({
      status: "failed",
      reason: "http_502",
    });
    expect(await registerOrbRelayTarget(cfg, (async () => Response.json({ code: "ETIMEDOUT" }, { status: 500 })) as typeof fetch)).toEqual({
      status: "failed",
      reason: "http_500",
    });
  });

  it("truncates an overlong error hint instead of logging an unbounded body", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    const longMessage = "x".repeat(500);
    const result = await registerOrbRelayTarget(cfg, (async () => Response.json({ error: longMessage }, { status: 500 })) as typeof fetch);
    expect(result.reason).toBe(`http_500: ${"x".repeat(200)}`);
  });

  it("does not read relay registration failure bodies whose Content-Length exceeds the diagnostic cap", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"must not be read"}'));
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    });

    const result = await registerOrbRelayTarget(
      cfg,
      (async () =>
        new Response(body, {
          status: 500,
          headers: { "content-length": "2001" },
        })) as typeof fetch,
    );

    expect(result).toEqual({ status: "failed", reason: "http_500" });
    expect(canceled).toBe(true);
  });


  it("falls back to the bare status when the diagnostic response has no body", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    const result = await registerOrbRelayTarget(cfg, (async () => new Response(null, { status: 500 })) as typeof fetch);
    expect(result).toEqual({ status: "failed", reason: "http_500" });
  });

  it("truncates and cancels a single oversized diagnostic stream chunk", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"oversized_chunk"}'.padEnd(2_100, " ")));
      },
      cancel() {
        canceled = true;
      },
    });

    const result = await registerOrbRelayTarget(cfg, (async () => new Response(body, { status: 500 })) as typeof fetch);

    expect(result).toEqual({ status: "failed", reason: "http_500: oversized_chunk" });
    expect(canceled).toBe(true);
  });

  it("stream-reads at most the relay registration diagnostic cap and cancels the remainder", async () => {
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    let pulls = 0;
    let canceled = false;
    const boundedJson = '{"error":"bounded_broker_error"}';
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(pulls === 1 ? boundedJson.padEnd(2_000, " ") : "x".repeat(10_000)));
      },
      cancel() {
        canceled = true;
      },
    });

    const result = await registerOrbRelayTarget(cfg, (async () => new Response(body, { status: 500 })) as typeof fetch);

    expect(result).toEqual({ status: "failed", reason: "http_500: bounded_broker_error" });
    expect(pulls).toBeLessThanOrEqual(2);
    expect(canceled).toBe(true);
  });
});

describe("registerOrbRelayTargetWithRetry", () => {
  it("skips outside broker mode without touching state", async () => {
    const state = createOrbRelayRegistrationState();
    expect(await registerOrbRelayTargetWithRetry({}, state)).toEqual({ status: "skipped" });
    expect(state).toEqual({ registered: false, lastAttemptAtMs: null, attempts: 0, consecutiveFailures: 0 });
  });

  it("attempts, marks registered on success, and never attempts again", async () => {
    const state = createOrbRelayRegistrationState();
    const { fetchImpl, calls } = captureFetch(new Response("ok"));
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };

    const first = await registerOrbRelayTargetWithRetry(cfg, state, 1_000, fetchImpl);
    expect(first).toEqual({ status: "registered" });
    expect(state).toEqual({ registered: true, lastAttemptAtMs: 1_000, attempts: 1, consecutiveFailures: 0 });

    const second = await registerOrbRelayTargetWithRetry(cfg, state, 2_000, fetchImpl);
    expect(second).toEqual({ status: "already_registered" });
    expect(calls).toHaveLength(1); // the second call never re-fetched
  });

  it("backs off after a failure and only retries once the backoff window elapses", async () => {
    const state = createOrbRelayRegistrationState();
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    const failThenSucceed = (async () => new Response("no", { status: 500 })) as typeof fetch;

    const first = await registerOrbRelayTargetWithRetry(cfg, state, 0, failThenSucceed);
    expect(first).toEqual({ status: "failed", reason: "http_500" });
    expect(state.attempts).toBe(1);
    expect(state.consecutiveFailures).toBe(1);

    // Still inside the backoff window — must not re-attempt (no fetch call at all).
    const stillBackingOff = await registerOrbRelayTargetWithRetry(
      cfg,
      state,
      ORB_RELAY_REGISTER_RETRY_BACKOFF_MS - 1,
      (async () => {
        throw new Error("must not fetch during backoff");
      }) as typeof fetch,
    );
    expect(stillBackingOff).toEqual({ status: "backoff" });
    expect(state.attempts).toBe(1);
    expect(state.consecutiveFailures).toBe(1); // backoff never re-attempts, so the streak doesn't move

    // Backoff elapsed — retries and can now recover.
    const { fetchImpl: successFetch } = captureFetch(new Response("ok"));
    const recovered = await registerOrbRelayTargetWithRetry(cfg, state, ORB_RELAY_REGISTER_RETRY_BACKOFF_MS, successFetch);
    expect(recovered).toEqual({ status: "registered" });
    expect(state).toEqual({ registered: true, lastAttemptAtMs: ORB_RELAY_REGISTER_RETRY_BACKOFF_MS, attempts: 2, consecutiveFailures: 0 });
  });

  it("passes through a skipped result from the underlying attempt (e.g. push mode with no public origin) without arming backoff", async () => {
    const state = createOrbRelayRegistrationState();
    const result = await registerOrbRelayTargetWithRetry({ ORB_ENROLLMENT_SECRET: "s" }, state, 500);
    expect(result).toEqual({ status: "skipped" });
    // skipped still counts as an attempt (it went through the backoff gate), but never registers.
    expect(state.registered).toBe(false);
    // A skip is an intentional no-op (e.g. push mode with no public origin yet), not a broker failure --
    // it must not move the consecutive-failure streak either direction.
    expect(state.consecutiveFailures).toBe(0);
  });

  it("grows the consecutive-failure streak across repeated failures and resets it to 0 on the next success", async () => {
    const state = createOrbRelayRegistrationState();
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    const failing = (async () => new Response("no", { status: 500 })) as typeof fetch;

    let nowMs = 0;
    for (let i = 1; i <= ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK; i++) {
      const result = await registerOrbRelayTargetWithRetry(cfg, state, nowMs, failing);
      expect(result).toEqual({ status: "failed", reason: "http_500" });
      expect(state.consecutiveFailures).toBe(i);
      nowMs += ORB_RELAY_REGISTER_RETRY_BACKOFF_MS;
    }
    expect(state.consecutiveFailures).toBe(ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK);

    const { fetchImpl: successFetch } = captureFetch(new Response("ok"));
    const recovered = await registerOrbRelayTargetWithRetry(cfg, state, nowMs, successFetch);
    expect(recovered).toEqual({ status: "registered" });
    expect(state.consecutiveFailures).toBe(0);
    expect(state.attempts).toBe(ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK + 1);
  });

  it("counts a thrown fetch (not just a non-ok response) towards the consecutive-failure streak", async () => {
    const state = createOrbRelayRegistrationState();
    const cfg = { ORB_ENROLLMENT_SECRET: "s", PUBLIC_API_ORIGIN: "https://me.example" };
    const throwing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const result = await registerOrbRelayTargetWithRetry(cfg, state, 0, throwing);
    expect(result).toEqual({ status: "failed", reason: "network down" });
    expect(state.consecutiveFailures).toBe(1);
  });
});

describe("drainOrbRelay (pull-mode drain)", () => {
  it("returns [] when not in broker mode (no enrollment secret)", async () => {
    expect(await drainOrbRelay({})).toEqual([]);
  });

  it("POSTs the ack list, parses returned events, and filters malformed ones (#zero-trace-webhook-loss: logs + counts the drop)", async () => {
    resetMetrics();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fetchImpl, calls } = captureFetch(
      Response.json({
        events: [
          { deliveryId: "d1", eventName: "pull_request", rawBody: "{\"a\":1}" },
          { deliveryId: "d2", eventName: "check_suite", rawBody: "{}" },
          { deliveryId: "bad", eventName: "x" }, // no rawBody → filtered out
        ],
      }),
    );
    const out = await drainOrbRelay({ ORB_ENROLLMENT_SECRET: "s" }, ["prev-1"], fetchImpl);
    expect(out).toEqual([
      { deliveryId: "d1", eventName: "pull_request", rawBody: "{\"a\":1}" },
      { deliveryId: "d2", eventName: "check_suite", rawBody: "{}" },
    ]);
    expect(calls[0]?.url).toBe("https://gittensory-api.aethereal.dev/v1/orb/relay/pull");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer s");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ack: ["prev-1"] });
    expect(counterValue("gittensory_orb_relay_malformed_events_total")).toBe(1);
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("orb_relay_malformed_event_dropped"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "orb_relay_malformed_event_dropped", hasDeliveryId: true, hasEventName: true, hasRawBody: false });
    errors.mockRestore();
  });

  it("tolerates a missing events array (?? [] arm)", async () => {
    expect(await drainOrbRelay({ ORB_ENROLLMENT_SECRET: "s" }, [], (async () => Response.json({})) as typeof fetch)).toEqual([]);
  });

  it("throws on non-ok / thrown / unsafe-URL so the monitor does not record false progress", async () => {
    await expect(drainOrbRelay({ ORB_ENROLLMENT_SECRET: "s" }, [], (async () => new Response("no", { status: 403 })) as typeof fetch)).rejects.toThrow("orb_relay_drain_http_403");
    await expect(drainOrbRelay({ ORB_ENROLLMENT_SECRET: "s" }, [], (async () => { throw new Error("down"); }) as typeof fetch)).rejects.toThrow("down");
    await expect(drainOrbRelay({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "http://broker.example" }, [], (async () => { throw new Error("unsafe should not fetch"); }) as typeof fetch)).rejects.toThrow(/must use https/);
    await expect(drainOrbRelay({ ORB_ENROLLMENT_SECRET: "s" }, [], (async () => Promise.reject("down")) as typeof fetch)).rejects.toThrow("orb_relay_drain_failed");
  });
});
