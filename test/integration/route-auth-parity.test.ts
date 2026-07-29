// Every route's DECLARED auth is the auth it actually enforces (#9851).
//
// `ORB_AND_CONTROL_ROUTE_SPECS` and `INTERNAL_AND_PUBLIC_ROUTE_SPECS` were each exported with a comment
// naming this file -- "exported for the meta-test that asserts every entry's declared auth matches the
// middleware that actually gates it" -- and the test was never written. Two exports maintained for a
// guarantee nobody built, while the `auth` on every ORB, internal, app and repo route went unverified.
//
// It asserts BEHAVIOUR, not wiring, and deliberately so. Auth here is enforced inside handlers (only
// `/v1/internal/*` has a path-scoped middleware), so "read the middleware chain" has nothing uniform to
// read -- and a chain that exists proves less than a route that actually refuses. So: send every declared
// route a request with NO credentials and require the answer to match what the document promises.
//
// The document is what an operator or integrator reads to decide what is protected. A route that claims
// `auth: "token"` and answers 200 to an anonymous caller is exactly the failure #9707 was, one level up.
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { ORB_AND_CONTROL_ROUTE_SPECS } from "../../src/openapi/orb-and-control-route-specs";
import { INTERNAL_AND_PUBLIC_ROUTE_SPECS } from "../../src/openapi/internal-and-public-route-specs";

/** Statuses that prove a credential was demanded. 403 counts: the route authenticated, then refused. */
const REFUSED = new Set([401, 403]);

/**
 * Headers that make a webhook-shaped request IDENTIFIABLE without making it authentic.
 *
 * The relay and webhook handlers reject a request they cannot identify (`missing_github_headers`) before
 * they verify its signature, which is correct -- but it means a bare request never reaches the auth check
 * this test exists to exercise. Supplying the identifying headers, and nothing that authenticates, is what
 * proves the signature is actually required.
 */
const IDENTIFYING_HEADERS = { "x-github-delivery": "route-auth-parity", "x-github-event": "ping" };

/**
 * A concrete request path for a spec's template. Values are deliberately implausible -- this test must
 * never reach a real record, and a route that refuses anonymously refuses regardless of the id.
 */
function concretePath(template: string): string {
  return template.replace(/\{[^}]+\}/g, "route-auth-parity");
}

/**
 * Env that makes otherwise-404 routes REACHABLE, so their auth is exercised rather than skipped: the broker
 * routes 404 until the flag is on, and the relay 404s on an instance with no enrollment secret ("not a
 * brokered self-host"). Neither value authenticates anything, and BOTH directions below use it.
 */
const REACHABILITY_ENV = { ORB_BROKER_ENABLED: "1", ORB_ENROLLMENT_SECRET: "route-auth-parity-not-a-credential" } as const;

const SPECS = [...ORB_AND_CONTROL_ROUTE_SPECS, ...INTERNAL_AND_PUBLIC_ROUTE_SPECS];

describe("route auth parity (#9851)", () => {
  it("covers both spec tables, so neither can silently empty out", () => {
    // The check this file exists for is worthless if the tables it reads go empty; #9526's own manifest
    // guard is the precedent (a watcher that watches nothing passes forever).
    expect(ORB_AND_CONTROL_ROUTE_SPECS.length).toBeGreaterThan(10);
    expect(INTERNAL_AND_PUBLIC_ROUTE_SPECS.length).toBeGreaterThan(10);
  });

  it("declares an auth value the document knows how to render, on every entry", () => {
    const known = new Set(["public", "token", "session", "internal", "orb", "webhook"]);
    const unknown = SPECS.filter((spec) => !known.has(spec.auth)).map((spec) => `${spec.method} ${spec.path} -> ${spec.auth}`);
    expect(unknown).toEqual([]);
  });

  it("REFUSES an unauthenticated request to every route that declares it needs a credential", async () => {
    const app = createApp();
    // The ORB broker routes are mounted but answer 404 until this flag is on. Enabling it EXERCISES their
    // auth instead of skipping them -- a flag-gated route still has a declared auth to honour.
    const env = createTestEnv(REACHABILITY_ENV);
    const failures: string[] = [];

    for (const spec of SPECS) {
      if (spec.auth === "public") continue;
      const path = concretePath(spec.path);
      const sendsBody = spec.method !== "get" && spec.method !== "delete";
      const response = await Promise.resolve(
        app.request(
          path,
          { method: spec.method.toUpperCase(), ...(sendsBody ? { body: "{}", headers: { "content-type": "application/json", ...IDENTIFYING_HEADERS } } : { headers: IDENTIFYING_HEADERS }) },
          env,
        ),
      );

      // 404 means the spec describes a route the app does not mount -- a documented endpoint that does not
      // exist is its own defect, and silently skipping it would be how this test learns to pass on nothing.
      if (response.status === 404) {
        failures.push(`${spec.method.toUpperCase()} ${spec.path} declares auth=${spec.auth} but is not mounted (404)`);
        continue;
      }
      // A signature-authenticated route may legitimately reject a malformed body before it verifies the
      // signature: both answers refuse the request, and this test cannot synthesize a valid payload for
      // every webhook shape. What it still proves is that an unsigned request never SUCCEEDS.
      if (spec.auth === "webhook" && response.status === 400) continue;
      if (!REFUSED.has(response.status)) {
        failures.push(`${spec.method.toUpperCase()} ${spec.path} declares auth=${spec.auth} but answered ${response.status} with no credentials`);
      }
    }

    expect(failures, `${failures.length} route(s) do not enforce their declared auth`).toEqual([]);
  }, 120_000);

  it("does NOT demand a credential on a route that declares itself public", async () => {
    // The other direction: a route documented as open must not answer 401, or the document is telling an
    // integrator to skip auth on something that will reject them. SAME env as above on purpose -- with a
    // different one, a flag-gated route 404s here and this direction silently checks nothing for it, which
    // is how a wrongly-public declaration would slip through.
    const app = createApp();
    const env = createTestEnv(REACHABILITY_ENV);
    const failures: string[] = [];

    for (const spec of SPECS) {
      if (spec.auth !== "public") continue;
      const response = await Promise.resolve(
        app.request(concretePath(spec.path), { method: spec.method.toUpperCase(), ...(spec.method === "get" || spec.method === "delete" ? {} : { body: "{}", headers: { "content-type": "application/json", ...IDENTIFYING_HEADERS } }) }, env),
      );
      if (response.status === 401) failures.push(`${spec.method.toUpperCase()} ${spec.path} declares auth=public but answered 401`);
    }

    expect(failures).toEqual([]);
  }, 120_000);
});
