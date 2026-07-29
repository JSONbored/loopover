// The app's global error boundary (`app.onError`).
//
// ── WHAT THIS DOES AND DOES NOT CHANGE ───────────────────────────────────────────────────────────────
// Hono ALWAYS installs a default error handler internally (hono-base.js), so an uncaught route throw was
// never an unhandled crash: it already became a 500, and `compose.js` sets `context.error` BEFORE dispatching
// to whichever handler is installed — which is what worker-posthog.ts's capture middleware reads. Installing
// this one preserves that (the assignment is unconditional and upstream of the handler), so error capture is
// unaffected. What the default gets WRONG for this app is the shape of what it returns and logs:
//
//   1. `c.text("Internal Server Error", 500)` — a text/plain body from a JSON API. Every other route in this
//      app answers `{ error: ... }`, so a client parsing JSON hits a parse failure on precisely the response
//      it most needs to understand. Now a 500 is `{ error: "internal_error" }` like every other error here.
//
//   2. `console.error(err)` — a raw Error object. This codebase's log forwarder keys on STRUCTURED JSON
//      (`{level:"error", event, ...}`); a bare Error is not classified, and carries no method/path, so a
//      production 500 could not be traced back to the route that raised it. Now it is one structured line
//      with the request's method and path.
//
// ── WHAT IS DELIBERATELY PRESERVED ───────────────────────────────────────────────────────────────────
// An `HTTPException` carries its OWN response and status. Hono's default returns it verbatim, and so does
// this: swallowing it into a 500 would turn every intentional 401/403/404/413/422 raised by middleware into
// an opaque server error, which is the single most damaging thing a global handler can get wrong.
//
// ── WHAT NEVER REACHES THE CLIENT ────────────────────────────────────────────────────────────────────
// The body carries a fixed code and nothing else. No message, no stack, no cause — several routes here are
// unauthenticated, and an error string can carry a query fragment, a binding name, or an upstream URL. The
// detail goes to the log, which is operator-only, and is bounded there.
import type { Context, MiddlewareHandler } from "hono";
import { errorMessage, errorStack } from "../utils/json";

/** The single body every unexpected failure returns. A stable code rather than prose: a client can branch on
 *  it, and it cannot accidentally grow to include something internal. */
export const INTERNAL_ERROR_BODY = { error: "internal_error" } as const;

/**
 * The global `onError` handler. Exported so it can be tested through a real Hono dispatch rather than by
 * faking a Context — the failure modes worth pinning (status preservation, no leakage) are only meaningful
 * end to end.
 */
export function handleAppError(error: Error, c: Context): Response {
  // Duck-typed on `getResponse` exactly as Hono's own default handler does, rather than
  // `instanceof HTTPException`: a workspace with several packages depending on hono can end up with two
  // copies in one module graph, and an `instanceof` check across them would collapse an intentional 4xx
  // into a 500. Asserted with a hand-rolled foreign exception in the tests.
  if (typeof error === "object" && "getResponse" in error && typeof (error as { getResponse: unknown }).getResponse === "function") {
    const response = (error as unknown as { getResponse: () => Response }).getResponse();
    // `c.newResponse(res.body, res)` rather than returning `res` directly, mirroring Hono's default: it
    // re-applies the context's own headers (CORS, content-type negotiation) that middleware already set.
    return c.newResponse(response.body, response);
  }
  console.error(
    JSON.stringify({
      level: "error",
      event: "unhandled_route_error",
      method: c.req.method,
      // `c.req.path` is the matched path WITHOUT the query string, so a token or id in a query parameter
      // cannot ride into the log.
      path: c.req.path,
      message: errorMessage(error),
      stack: errorStack(error),
    }),
  );
  return c.json(INTERNAL_ERROR_BODY, 500);
}

/**
 * The other half of the boundary: a thrown NON-Error.
 *
 * Hono's `compose()` routes a caught throw to `onError` only when it is `instanceof Error` -- otherwise it
 * RE-THROWS (`else { throw err; }`). So `throw "a string"`, a rejected promise carrying a plain object, or a
 * library that throws a non-Error escapes `app.onError` entirely: no JSON response, no structured log, and
 * no `context.error`, so the PostHog capture middleware never sees it either. Verified empirically, not
 * assumed -- a test throws a bare string and, without this, the request rejects rather than responding.
 *
 * A try/catch around `next()` is the right shape for exactly this case and ONLY this case: an `Error` thrown
 * below has already been converted to a response several dispatch levels down (which is why
 * worker-posthog.ts documents that a try/catch here would never see one), so this adds no second handling
 * path for the normal case -- it catches precisely what `onError` structurally cannot.
 *
 * Register OUTERMOST so it also covers a non-Error thrown by another middleware.
 */
export function nonErrorBoundary(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (thrown) {
      // An Error reaching here would mean Hono's own handling changed; re-throw rather than silently
      // duplicating onError's job, so that change surfaces instead of being masked.
      if (thrown instanceof Error) throw thrown;
      console.error(
        JSON.stringify({
          level: "error",
          event: "unhandled_non_error_throw",
          method: c.req.method,
          path: c.req.path,
          // `String(thrown)` rather than the value: a thrown object could serialize to something enormous
          // or circular, and this line has to be loggable no matter what was thrown.
          thrown: String(thrown).slice(0, 500),
        }),
      );
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  };
}
