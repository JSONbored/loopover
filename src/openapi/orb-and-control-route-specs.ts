// Spec entries for the ORB ingress, the control-panel app surface, and the per-repo key/settings
// routes (#9531, batch 1 of the ratchet).
//
// These 24 routes served real traffic while the published document said nothing about them -- the
// whole ORB management surface among them, which is the precondition for #9522's management tools.
//
// SPEC-ONLY, deliberately. `registerRouteSpec` contributes a correct operation without moving the
// handler through `defineRoute`'s validating wrapper. Moving handlers is the other half of #9531 and
// happens per family; separating the two means the document stops lying about what the app serves
// now, rather than after every handler has been rewritten. Each entry still carries the things the
// old hand-registered operations never did: a stable operationId, real tags, and an auth level that
// derives its security stanza rather than having one bolted on by path prefix.
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { registerRouteSpec, type RouteAuth, type RouteMethod } from "./define-route";

type SpecEntry = {
  method: RouteMethod;
  path: string;
  operationId: string;
  tags: [string, ...string[]];
  summary: string;
  auth: RouteAuth;
  responses: Record<number, { description: string }>;
};

/** Shared by every ORB-authenticated endpoint. */
const ORB_AUTH_RESPONSES = { 401: { description: "Missing or invalid ORB instance token" } };
const INTERNAL_AUTH_RESPONSES = { 401: { description: "Invalid internal token" } };
const SESSION_AUTH_RESPONSES = { 401: { description: "Not signed in" }, 403: { description: "Insufficient control-panel role" } };

const ORB_ROUTES: SpecEntry[] = [
  {
    method: "post",
    path: "/v1/orb/token",
    operationId: "mintOrbInstanceToken",
    tags: ["ORB"],
    summary: "Mint an ORB instance token",
    // The minting endpoint is reached WITH the enrollment secret, not with a token it has yet to
    // issue -- so `orb`, not `public`: a credential is required, just not a LoopOver bearer.
    auth: "orb",
    responses: { 200: { description: "Instance token issued" }, 400: { description: "Malformed enrollment request" }, ...ORB_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/orb/relay",
    operationId: "relayOrbEvent",
    tags: ["ORB"],
    summary: "Relay one ORB event to the hosted control plane",
    auth: "orb",
    responses: { 202: { description: "Event accepted for processing" }, 400: { description: "Malformed relay payload" }, ...ORB_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/orb/relay/register",
    operationId: "registerOrbRelayInstance",
    tags: ["ORB"],
    summary: "Register a self-hosted ORB instance with the relay",
    auth: "orb",
    responses: { 200: { description: "Instance registered" }, 400: { description: "Malformed registration" }, ...ORB_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/orb/relay/pull",
    operationId: "pullOrbRelayWork",
    tags: ["ORB"],
    summary: "Pull queued relay work for an ORB instance",
    auth: "orb",
    responses: { 200: { description: "Queued work, possibly empty" }, ...ORB_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/orb/webhook",
    operationId: "receiveOrbWebhook",
    tags: ["ORB"],
    // Signature-verified, not bearer-authenticated -- the one route whose credential is a header
    // over the raw body.
    auth: "webhook",
    summary: "Receive a signed ORB webhook",
    responses: { 202: { description: "Webhook accepted" }, 400: { description: "Malformed webhook body" }, 401: { description: "Signature verification failed" } },
  },
  {
    method: "get",
    path: "/v1/orb/oauth/callback",
    operationId: "completeOrbOauth",
    tags: ["ORB"],
    // Genuinely public: the browser arrives here from GitHub with a one-time code and no credential
    // of its own; the code IS the proof.
    auth: "public",
    summary: "Complete the ORB GitHub OAuth flow",
    responses: { 302: { description: "Redirect back to the ORB instance" }, 400: { description: "Missing or invalid OAuth code" } },
  },
];

const INTERNAL_ORB_ROUTES: SpecEntry[] = [
  {
    method: "get",
    path: "/v1/internal/orb/instances",
    operationId: "listOrbInstances",
    tags: ["ORB", "Internal"],
    summary: "List registered ORB instances",
    auth: "internal",
    responses: { 200: { description: "Registered instances" }, ...INTERNAL_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/internal/orb/instances/register",
    operationId: "registerOrbInstanceInternal",
    tags: ["ORB", "Internal"],
    summary: "Register an ORB instance from the control plane",
    auth: "internal",
    responses: { 200: { description: "Instance registered" }, 400: { description: "Malformed registration" }, ...INTERNAL_AUTH_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/internal/orb/installations",
    operationId: "listOrbInstallations",
    tags: ["ORB", "Internal"],
    summary: "List GitHub App installations known to the ORB control plane",
    auth: "internal",
    responses: { 200: { description: "Installations" }, ...INTERNAL_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/internal/orb/installations/register",
    operationId: "registerOrbInstallation",
    tags: ["ORB", "Internal"],
    summary: "Register a GitHub App installation with the ORB control plane",
    auth: "internal",
    responses: { 200: { description: "Installation registered" }, 400: { description: "Malformed registration" }, ...INTERNAL_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/internal/orb/installations/backfill",
    operationId: "backfillOrbInstallations",
    tags: ["ORB", "Internal"],
    summary: "Backfill ORB installation records from GitHub",
    auth: "internal",
    responses: { 202: { description: "Backfill queued" }, ...INTERNAL_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/internal/orb/enrollments",
    operationId: "createOrbEnrollment",
    tags: ["ORB", "Internal"],
    summary: "Create an ORB instance enrollment",
    auth: "internal",
    responses: { 200: { description: "Enrollment created" }, 400: { description: "Malformed enrollment" }, ...INTERNAL_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/internal/orb/enrollments/:enrollId/revoke",
    operationId: "revokeOrbEnrollment",
    tags: ["ORB", "Internal"],
    summary: "Revoke an ORB instance enrollment",
    auth: "internal",
    responses: { 200: { description: "Enrollment revoked" }, 404: { description: "No such enrollment" }, ...INTERNAL_AUTH_RESPONSES },
  },
];

const APP_ROUTES: SpecEntry[] = [
  {
    method: "get",
    path: "/v1/app/installations",
    operationId: "listAppInstallations",
    tags: ["Control panel"],
    summary: "List the GitHub App installations the caller can administer",
    auth: "session",
    responses: { 200: { description: "Installations" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/app/installations/:id/health",
    operationId: "getAppInstallationHealth",
    tags: ["Control panel"],
    summary: "Return one installation's health summary",
    auth: "session",
    responses: { 200: { description: "Installation health" }, 404: { description: "No such installation" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/app/installations/:id/repair",
    operationId: "getAppInstallationRepair",
    tags: ["Control panel"],
    summary: "Return the repair plan for an unhealthy installation",
    auth: "session",
    responses: { 200: { description: "Repair plan" }, 404: { description: "No such installation" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/app/installations/:id/repair/refresh",
    operationId: "refreshAppInstallationRepair",
    tags: ["Control panel"],
    summary: "Recompute an installation's repair plan",
    auth: "session",
    responses: { 200: { description: "Repair plan recomputed" }, 404: { description: "No such installation" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "put",
    path: "/v1/app/installations/:id/agent/bulk-settings",
    operationId: "bulkUpdateInstallationAgentSettings",
    tags: ["Control panel", "Agent automation"],
    summary: "Apply agent settings across every repo in an installation",
    auth: "session",
    responses: { 200: { description: "Settings applied" }, 400: { description: "Malformed settings" }, 404: { description: "No such installation" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/app/kill-switch",
    operationId: "getFleetKillSwitch",
    tags: ["Control panel", "Operations"],
    summary: "Read the fleet-wide agent kill switch",
    auth: "session",
    responses: { 200: { description: "Kill-switch state" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/app/kill-switch",
    operationId: "setFleetKillSwitch",
    tags: ["Control panel", "Operations"],
    summary: "Set the fleet-wide agent kill switch",
    auth: "session",
    responses: { 200: { description: "Kill switch updated" }, 400: { description: "Malformed request" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/app/fleet/config-push",
    operationId: "pushFleetConfig",
    tags: ["Control panel", "Operations"],
    summary: "Push a configuration change across the fleet",
    auth: "session",
    responses: { 202: { description: "Config push queued" }, 400: { description: "Malformed push" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/app/miner-dashboard/refresh",
    operationId: "refreshMinerDashboard",
    tags: ["Control panel"],
    summary: "Recompute the miner dashboard aggregates",
    auth: "session",
    responses: { 202: { description: "Refresh queued" }, ...SESSION_AUTH_RESPONSES },
  },
];

/** The per-repo BYO-key and settings routes. Each key route exists twice -- once maintainer-facing
 *  under /v1/repos, once internal -- and the pair is specced together so they cannot drift. */
const REPO_ROUTES: SpecEntry[] = [
  ...(["ai-key", "linear-key"] as const).flatMap((kind): SpecEntry[] => {
    const label = kind === "ai-key" ? "AI provider" : "Linear";
    const Kind = kind === "ai-key" ? "Ai" : "Linear";
    return [
      {
        method: "get",
        path: `/v1/repos/:owner/:repo/${kind}`,
        operationId: `get${Kind}Key`,
        tags: ["Repositories", "Bring your own key"],
        summary: `Report whether a ${label} key is configured for this repo (never the key itself)`,
        auth: "session",
        responses: { 200: { description: "Key presence and metadata" }, 404: { description: "Repo not registered" }, ...SESSION_AUTH_RESPONSES },
      },
      {
        method: "post",
        path: `/v1/repos/:owner/:repo/${kind}`,
        operationId: `set${Kind}Key`,
        tags: ["Repositories", "Bring your own key"],
        summary: `Store a ${label} key for this repo`,
        auth: "session",
        responses: { 200: { description: "Key stored" }, 400: { description: "Malformed key" }, ...SESSION_AUTH_RESPONSES },
      },
      {
        method: "delete",
        path: `/v1/repos/:owner/:repo/${kind}`,
        operationId: `delete${Kind}Key`,
        tags: ["Repositories", "Bring your own key"],
        summary: `Remove this repo's ${label} key`,
        auth: "session",
        responses: { 200: { description: "Key removed" }, ...SESSION_AUTH_RESPONSES },
      },
      {
        method: "get",
        path: `/v1/internal/repos/:owner/:repo/${kind}`,
        operationId: `get${Kind}KeyInternal`,
        tags: ["Bring your own key", "Internal"],
        summary: `Read this repo's ${label} key state from the control plane`,
        auth: "internal",
        responses: { 200: { description: "Key presence and metadata" }, ...INTERNAL_AUTH_RESPONSES },
      },
      {
        method: "post",
        path: `/v1/internal/repos/:owner/:repo/${kind}`,
        operationId: `set${Kind}KeyInternal`,
        tags: ["Bring your own key", "Internal"],
        summary: `Store this repo's ${label} key from the control plane`,
        auth: "internal",
        responses: { 200: { description: "Key stored" }, 400: { description: "Malformed key" }, ...INTERNAL_AUTH_RESPONSES },
      },
      {
        method: "delete",
        path: `/v1/internal/repos/:owner/:repo/${kind}`,
        operationId: `delete${Kind}KeyInternal`,
        tags: ["Bring your own key", "Internal"],
        summary: `Remove this repo's ${label} key from the control plane`,
        auth: "internal",
        responses: { 200: { description: "Key removed" }, ...INTERNAL_AUTH_RESPONSES },
      },
    ];
  }),
  {
    method: "put",
    path: "/v1/repos/:owner/:repo/settings",
    operationId: "updateRepoSettings",
    tags: ["Repositories"],
    summary: "Replace a repo's LoopOver settings",
    auth: "session",
    responses: { 200: { description: "Settings updated" }, 400: { description: "Malformed settings" }, ...SESSION_AUTH_RESPONSES },
  },
  {
    method: "put",
    path: "/v1/repos/:owner/:repo/ai-review",
    operationId: "updateRepoAiReviewMode",
    tags: ["Repositories"],
    summary: "Set a repo's AI-review mode",
    auth: "session",
    responses: { 200: { description: "AI-review mode updated" }, 400: { description: "Malformed mode" }, ...SESSION_AUTH_RESPONSES },
  },
];

/** Register every entry in this batch. Called from buildOpenApiSpec. */
export function registerOrbAndControlRouteSpecs(registry: OpenAPIRegistry): void {
  for (const entry of [...ORB_ROUTES, ...INTERNAL_ORB_ROUTES, ...APP_ROUTES, ...REPO_ROUTES]) {
    registerRouteSpec(registry, entry);
  }
}

/** Exported for the meta-test that asserts every entry's declared auth matches the middleware that
 *  actually gates it. */
export const ORB_AND_CONTROL_ROUTE_SPECS: readonly SpecEntry[] = [...ORB_ROUTES, ...INTERNAL_ORB_ROUTES, ...APP_ROUTES, ...REPO_ROUTES];
