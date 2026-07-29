import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { handleAppError, nonErrorBoundary, INTERNAL_ERROR_BODY } from "../../src/api/error-handler";

// The global error boundary. Every assertion below runs through a REAL Hono dispatch rather than a faked
// Context: the properties worth pinning (status preservation, no leakage, `c.error` still being set for the
// PostHog capture) are only meaningful end to end, and a hand-built context would let all three pass while
// the wiring was wrong.

/** A minimal app wired exactly the way createApp wires it, with routes that raise each failure shape. */
function appWithErrors() {
  const app = new Hono();
  app.onError(handleAppError);
  app.use("*", nonErrorBoundary());
  app.get("/boom", () => {
    throw new Error("upstream token abc123 rejected at https://internal.example/db");
  });
  app.get("/http-exception/:status", (c) => {
    throw new HTTPException(Number(c.req.param("status")) as 401, { message: "nope" });
  });
  app.get("/non-error", () => {
    // A thrown non-Error still has to produce a response rather than escaping the boundary.
    throw "a bare string";
  });
  app.get("/ok", (c) => c.json({ ok: true }));
  return app;
}

describe("global onError handler", () => {
  it("REGRESSION: an unexpected throw returns JSON, not Hono's default text/plain body", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await appWithErrors().request("/boom");
    expect(res.status).toBe(500);
    // Every other route in this app answers `{ error: ... }`; a text/plain 500 breaks a client's JSON parse
    // on precisely the response it most needs to read.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(INTERNAL_ERROR_BODY);
    warn.mockRestore();
  });

  it("REGRESSION: the response body leaks NOTHING — no message, stack, URL or token from the error", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = await (await appWithErrors().request("/boom")).text();
    for (const secret of ["abc123", "internal.example", "upstream token", "rejected", "at /", ".ts:"]) {
      expect(body).not.toContain(secret);
    }
    // The whole body is the fixed code and nothing else.
    expect(JSON.parse(body)).toEqual({ error: "internal_error" });
    warn.mockRestore();
  });

  it("logs ONE structured line the forwarder can classify, with method and path for correlation", async () => {
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    await appWithErrors().request("/boom", { method: "GET" });
    expect(errors).toHaveLength(1);
    const logged = JSON.parse(errors[0] as string) as Record<string, unknown>;
    // Structured, not a raw Error object — the forwarder keys on `level`/`event`.
    expect(logged).toMatchObject({ level: "error", event: "unhandled_route_error", method: "GET", path: "/boom" });
    // The detail the BODY withholds lives here, where only an operator sees it.
    expect(String(logged["message"])).toContain("abc123");
    expect(typeof logged["stack"]).toBe("string");
    warn.mockRestore();
  });

  it("REGRESSION: a query string never reaches the log — `c.req.path` is the matched path only", async () => {
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    await appWithErrors().request("/boom?token=supersecret&id=42");
    expect(errors[0]).not.toContain("supersecret");
    expect(JSON.parse(errors[0] as string).path).toBe("/boom");
    warn.mockRestore();
  });

  it("REGRESSION: an HTTPException keeps its OWN status — an intentional 4xx never collapses into a 500", async () => {
    // The single most damaging thing a global handler can get wrong: turning every deliberate 401/403/404
    // raised by middleware into an opaque server error.
    const app = appWithErrors();
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      const res = await app.request(`/http-exception/${status}`);
      expect({ status, got: res.status }).toEqual({ status, got: status });
    }
  });

  it("an HTTPException is NOT logged as an unhandled error — it is an outcome, not a fault", async () => {
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    await appWithErrors().request("/http-exception/401");
    expect(errors).toEqual([]);
    warn.mockRestore();
  });

  it("REGRESSION: a thrown NON-Error is contained — Hono re-throws those, so onError alone never sees them", async () => {
    // Verified empirically: without nonErrorBoundary the request REJECTS rather than responding, because
    // compose() only routes `instanceof Error` to onError and re-throws everything else.
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const res = await appWithErrors().request("/non-error");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(INTERNAL_ERROR_BODY);
    const logged = JSON.parse(errors[0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({ level: "error", event: "unhandled_non_error_throw", method: "GET", path: "/non-error" });
    expect(String(logged["thrown"])).toContain("a bare string");
    warn.mockRestore();
  });

  it("the non-Error boundary does NOT duplicate onError: an Error thrown below is handled once, by onError", async () => {
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    await appWithErrors().request("/boom");
    // Exactly one log line, and it is onError's -- the boundary re-throws Errors rather than handling them
    // a second time, so a change in Hono's own routing would surface instead of being masked.
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0] as string).event).toBe("unhandled_route_error");
    warn.mockRestore();
  });

  it("a huge or circular thrown value still produces a bounded, loggable line", async () => {
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const app = new Hono();
    app.onError(handleAppError);
    app.use("*", nonErrorBoundary());
    const circular: Record<string, unknown> = { big: "x".repeat(5000) };
    circular["self"] = circular;
    app.get("/circular", () => {
      throw circular;
    });
    const res = await app.request("/circular");
    expect(res.status).toBe(500);
    expect(String(JSON.parse(errors[0] as string).thrown).length).toBeLessThanOrEqual(500);
    warn.mockRestore();
  });

  it("INVARIANT: a successful route is untouched — the boundary costs nothing on the happy path", async () => {
    const res = await appWithErrors().request("/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("the boundary's own contract: it re-throws an Error rather than handling it a second time", async () => {
    // Exercised directly rather than through dispatch, because Hono converts an Error to a response several
    // levels below and one can never reach the boundary in normal operation. The guard exists so that if
    // Hono's routing ever changes, the Error surfaces to onError instead of being silently relabelled as an
    // `unhandled_non_error_throw` -- so the contract is worth pinning even though today nothing triggers it.
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const context = { req: { method: "GET", path: "/direct" }, json: () => new Response("unused") } as unknown as Parameters<ReturnType<typeof nonErrorBoundary>>[0];
    const boundary = nonErrorBoundary();
    const raised = new Error("an Error reached the boundary");
    await expect(
      boundary(context, () => {
        throw raised;
      }),
    ).rejects.toBe(raised);
    // Re-thrown untouched, and NOT logged as a non-Error throw.
    expect(errors).toEqual([]);
    warn.mockRestore();
  });

  it("carriesOwnResponse duck-types on getResponse, so a second hono copy cannot collapse a 4xx into a 500", async () => {
    // `instanceof HTTPException` would fail across two copies of hono in one module graph -- a real hazard
    // in a workspace with several packages depending on it. A hand-rolled object carrying getResponse is
    // treated exactly like a real HTTPException.
    const app = new Hono();
    app.onError(handleAppError);
    app.use("*", nonErrorBoundary());
    app.get("/foreign", () => {
      const foreign = new Error("from another hono copy") as Error & { getResponse: () => Response };
      foreign.getResponse = () => new Response("teapot", { status: 418 });
      throw foreign;
    });
    const errors: string[] = [];
    const warn = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const res = await app.request("/foreign");
    expect(res.status).toBe(418);
    expect(errors).toEqual([]); // an intentional status is an outcome, not a fault
    warn.mockRestore();
  });

  it("REGRESSION: `c.error` is still set, so the PostHog capture middleware keeps seeing failures", async () => {
    // Hono's compose() assigns `context.error` BEFORE dispatching to whichever handler is installed, so a
    // custom onError must not break error capture. Asserted through a middleware reading c.error exactly
    // the way worker-posthog.ts does.
    const seen: string[] = [];
    const app = new Hono();
    app.onError(handleAppError);
    app.use("*", async (c, next) => {
      await next();
      if (c.error) seen.push(c.error.message);
    });
    app.get("/boom", () => {
      throw new Error("captured");
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(seen).toEqual(["captured"]);
    warn.mockRestore();
  });
});
