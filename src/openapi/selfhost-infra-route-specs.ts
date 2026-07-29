// Spec entries for the endpoints the SELF-HOST Node entrypoint serves itself (#9750).
//
// `src/server.ts` answers these in its own `fetch` handler, before the request ever reaches the Hono app.
// That makes them invisible to the route↔spec ratchet, which walks `createApp()`'s route table -- so they
// have been served, and undocumented, since self-host shipped. An operator wiring a healthcheck or a
// Prometheus scrape had prose only.
//
// ANTI-ROT: `SELFHOST_INFRA_PATHS` is asserted against the paths `src/server.ts` actually intercepts, read
// out of its source (test/unit/selfhost-infra-route-specs.test.ts). A hand-kept list of paths served
// somewhere else is precisely the shape of rot this repo keeps finding -- it cannot fail on its own, so
// something has to fail for it.
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registerRouteSpec, type RouteMethod } from "./define-route";

/**
 * Every path `src/server.ts` names in a `path === "..."` comparison.
 *
 * Two of them need no operation here, and for the SAME reason rather than by exception: `/health` and
 * `/v1/github/webhook` are both served by the Hono app, which already documents them. The entrypoint only
 * gets to them first -- answering `/health` itself, and checking the webhook path to dedup a delivery
 * before letting the request through. So the set that needs speccing is this list minus whatever
 * `createApp()` serves, which the parity test computes from the live app rather than restating.
 */
export const SELFHOST_INFRA_PATHS = ["/health", "/metrics", "/ready", "/setup", "/setup/callback", "/v1/github/webhook"] as const;

/** The subset the Hono app does NOT serve, so nothing else can document them. */
export const SELFHOST_INFRA_SPEC_PATHS = ["/ready", "/metrics", "/setup", "/setup/callback"] as const;

const ReadinessSchema = z
  .looseObject({ ok: z.boolean() })
  .describe("Readiness result. `ok: false` is answered with a 503 so an orchestrator can act on the status line alone.");

type InfraSpec = {
  method: RouteMethod;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  responses: Record<number, { description: string; schema?: z.ZodTypeAny }>;
};

const SPECS: InfraSpec[] = [
  {
    method: "get",
    path: "/ready",
    operationId: "getSelfhostReadiness",
    summary: "Readiness probe for this self-hosted instance",
    description: "Runs the instance's readiness probes against its own database. Answers 503 when any probe fails, so a container orchestrator can gate traffic on the status code alone.",
    responses: {
      200: { description: "Every readiness probe passed", schema: ReadinessSchema },
      503: { description: "At least one readiness probe failed", schema: ReadinessSchema },
    },
  },
  {
    method: "get",
    path: "/metrics",
    operationId: "getSelfhostMetrics",
    summary: "Prometheus metrics for this self-hosted instance",
    description: "Prometheus text exposition (`text/plain; version=0.0.4`), not JSON — this is the scrape endpoint, and it is the one operation here whose response is deliberately not a schema.",
    responses: { 200: { description: "Metrics in Prometheus text exposition format" } },
  },
  {
    method: "get",
    path: "/setup",
    operationId: "getSelfhostSetupWizard",
    summary: "First-run GitHub App setup wizard",
    description:
      "Available only while no GitHub App is configured — a live install cannot be rebound. Returns the token-entry form until SELFHOST_SETUP_TOKEN is presented, via the `x-setup-token` header or an `authorization` bearer; never a query parameter, which would leak the secret to access logs and browser history. In brokered mode (ORB_ENROLLMENT_SECRET set) it short-circuits to a brokered-mode page instead.",
    responses: {
      200: { description: "The token-entry form, or the setup page once authenticated" },
      400: { description: "SELFHOST_SETUP_TOKEN or PUBLIC_API_ORIGIN is not configured" },
      403: { description: "A setup token was supplied and did not match" },
    },
  },
  {
    method: "post",
    path: "/setup",
    operationId: "postSelfhostSetupWizard",
    summary: "Submit the setup token from the wizard's form",
    description: "The browser half of the same wizard: the token travels in the POST body rather than a header, for the same reason it never travels in the URL.",
    responses: {
      200: { description: "The setup page, once the submitted token matched" },
      400: { description: "SELFHOST_SETUP_TOKEN or PUBLIC_API_ORIGIN is not configured" },
      403: { description: "The submitted token did not match" },
    },
  },
  {
    method: "get",
    path: "/setup/callback",
    operationId: "getSelfhostSetupCallback",
    summary: "GitHub App creation callback for the setup wizard",
    description:
      "Where GitHub returns after the operator creates the App. The one-time code is exchanged for the App's private key and webhook secret, so the redirect origin comes from PUBLIC_API_ORIGIN rather than the request's Host header — a spoofed Host would otherwise send the callback, and the credentials, somewhere else.",
    responses: {
      200: { description: "The App was created and its credentials were persisted" },
      400: { description: "No `code` parameter, or the wizard is not configured" },
      403: { description: "The `state` parameter did not match the one issued" },
      500: { description: "GitHub rejected the code exchange" },
    },
  },
];

export function registerSelfhostInfraRouteSpecs(registry: OpenAPIRegistry): void {
  for (const spec of SPECS) {
    registerRouteSpec(registry, {
      method: spec.method,
      path: spec.path,
      operationId: spec.operationId,
      tags: ["Self-host infra"],
      summary: spec.summary,
      description: spec.description,
      // No LoopOver credential reaches these: they are answered before the app's auth ever runs. The setup
      // wizard has its own one-off token, which is not an API credential and has no scheme here.
      auth: "public",
      responses: spec.responses,
    });
  }
}

/** The (method, path) pairs this module contributes, for the ratchet's "no operation without a route" side. */
export const SELFHOST_INFRA_ROUTE_KEYS: readonly string[] = SPECS.map((spec) => `${spec.method.toUpperCase()} ${spec.path}`);
