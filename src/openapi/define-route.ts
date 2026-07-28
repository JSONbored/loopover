// The route-registration seam (#9519).
//
// One call registers a route on the Hono app AND contributes its OpenAPI operation, from the same
// zod schemas that validate the request at runtime. That single-source property is the whole point:
// today the app's route table (createApp, 241 operations) and the spec's path list
// (buildOpenApiSpec, 151) are separate hand-maintained lists that had drifted apart by 90 routes,
// and request bodies are validated by inline schemas the published document never mentions.
//
// Deliberately a local shim rather than @hono/zod-openapi (decision recorded on #9519): 241 routes
// have to migrate incrementally, and this coexists with plain `app.get(...)` registrations, whereas
// adopting that library means rewriting createApp() wholesale and re-coupling the zod version. The
// emit path reuses the @asteasolutions/zod-to-openapi registry the repo already builds its spec
// with, so nothing about the generated document's shape changes.
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { OpenAPIRegistry, RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/**
 * Who a caller must be. These are the identity kinds `src/auth/security.ts` actually
 * authenticates, so the security stanza emitted into the document is derived from the same
 * declaration the runtime gate enforces -- replacing `isProtectedPath()`, a second, path-prefix
 * model of the same policy that had already drifted out of agreement with it.
 */
export type RouteAuth = "public" | "token" | "session" | "internal" | "orb" | "webhook";

export type RouteMethod = "get" | "post" | "put" | "patch" | "delete";

export type DefineRouteOptions<Body extends z.ZodTypeAny | undefined, Query extends z.ZodObject | undefined> = {
  method: RouteMethod;
  /** Hono-style path (`/v1/repos/:owner/:repo`). Normalized to OpenAPI form for the document. */
  path: string;
  /** Stable, hand-chosen operation id. Required: a generated client's method names come from these,
   *  so leaving them to be slugified from method+path makes every path edit a breaking API change
   *  for consumers. */
  operationId: string;
  /** At least one tag. The document currently emits `tags: []` everywhere, which collapses every
   *  operation into one flat namespace in generated clients and doc explorers alike. */
  tags: [string, ...string[]];
  summary: string;
  description?: string;
  auth: RouteAuth;
  request?: {
    body?: Body;
    query?: Query;
  };
  responses: Record<number, { description: string; schema?: z.ZodTypeAny }>;
};

/**
 * Every `:param` in the path, as an OpenAPI `in: path` parameter schema.
 *
 * Emitted automatically rather than declared per route: a templated segment with no matching
 * parameter is a schema-validation warning (Cloudflare 30046) and leaves a generated client with a
 * URL it cannot fill, and there is no case where a path parameter is optional -- so the correct
 * declaration is fully derivable from the path itself and nothing is gained by asking for it twice.
 */
function pathParameters(path: string): { params: z.ZodObject } | undefined {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  if (names.length === 0) return undefined;
  return { params: z.object(Object.fromEntries(names.map((name) => [name, z.string()]))) };
}

/** Hono writes `:param`; OpenAPI writes `{param}`. */
function toSpecPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * The security stanza a declared auth level emits.
 *
 * `public` carries none. `internal` is bearer-only -- there is no cookie path to it. `orb` and
 * `webhook` (#9531) exist because the ORB ingress genuinely does not authenticate the way the rest
 * of the API does, and collapsing them into `public` would publish a document that says these
 * routes need no credential at all. They need a DIFFERENT one: an ORB-issued bearer for the relay
 * and token endpoints, an HMAC signature header for the webhook. `requiresApiToken()` exempts both
 * from the LoopOver bearer check, which is what made them look public to the old path-prefix model.
 */
function securityFor(auth: RouteAuth): RouteConfig["security"] {
  // `[]`, not undefined: an empty security array is OpenAPI's explicit "this operation needs no
  // credential", where an ABSENT one means "not stated". The distinction is load-bearing here --
  // applySecurityMetadata fills in the legacy `registerPath` calls that never declared anything, and
  // it can only tell those apart from a deliberately public route if public says so out loud.
  if (auth === "public") return [];
  if (auth === "internal") return [{ LoopOverBearer: [] }];
  if (auth === "orb") return [{ OrbBearer: [] }];
  if (auth === "webhook") return [{ OrbWebhookSignature: [] }];
  return [{ LoopOverBearer: [] }, { LoopOverSessionCookie: [] }];
}

/**
 * The validation error shape.
 *
 * Matches what the hand-written `.safeParse` call sites in src/api/routes.ts already return
 * (`{ error: "invalid_<thing>_request", issues }`), so migrating a route through this seam does not
 * change the body a client sees on a 400.
 */
export function invalidRequestBody(kind: string, error: z.ZodError): { error: string; issues: unknown } {
  return { error: `invalid_${kind}_request`, issues: error.issues };
}

export type RouteHandlerArgs<Body, Query> = {
  body: Body;
  query: Query;
};

/**
 * Register a route on the app and in the OpenAPI registry from one definition.
 *
 * The handler receives already-validated `body`/`query` rather than a raw context accessor, so a
 * migrated handler cannot forget to parse -- the parse is the only way to reach the handler at all.
 */
export function defineRoute<
  AppEnv extends { Bindings: Record<string, unknown>; Variables: Record<string, unknown> },
  Body extends z.ZodTypeAny | undefined = undefined,
  Query extends z.ZodObject | undefined = undefined,
>(
  app: Hono<AppEnv>,
  registry: OpenAPIRegistry,
  options: DefineRouteOptions<Body, Query>,
  handler: (
    c: Context<AppEnv>,
    args: RouteHandlerArgs<Body extends z.ZodTypeAny ? z.infer<Body> : undefined, Query extends z.ZodObject ? z.infer<Query> : undefined>,
  ) => Response | Promise<Response>,
): void {
  registerRouteSpec(registry, options);

  const wrapped: MiddlewareHandler<AppEnv> = async (c) => {
    let body: unknown;
    if (options.request?.body) {
      // A body-carrying route with an unparseable/absent JSON body is a client error, not a 500 --
      // matching how the existing hand-written call sites treat `await c.req.json()` failures.
      const raw = await c.req.json().catch(() => undefined);
      const parsed = (options.request.body as z.ZodTypeAny).safeParse(raw);
      if (!parsed.success) return c.json(invalidRequestBody(options.operationId, parsed.error), 400);
      body = parsed.data;
    }
    let query: unknown;
    if (options.request?.query) {
      const parsed = (options.request.query as z.ZodTypeAny).safeParse(c.req.query());
      if (!parsed.success) return c.json(invalidRequestBody(options.operationId, parsed.error), 400);
      query = parsed.data;
    }
    return handler(c as Context<AppEnv>, { body, query } as never);
  };

  app[options.method](options.path, wrapped);
}

/** Spec-side view of a route definition: the same fields, with the request schemas widened, since
 *  emitting the document never needs the parsed types the handler does. */
export type RouteSpecOptions = Omit<DefineRouteOptions<z.ZodTypeAny | undefined, z.ZodObject | undefined>, "request"> & {
  request?: { body?: z.ZodTypeAny | undefined; query?: z.ZodObject | undefined } | undefined;
};

/** The spec half, exported separately so a route that cannot yet move its handler through the seam
 *  can still contribute a correct operation and leave the ratchet baseline. */
export function registerRouteSpec(registry: OpenAPIRegistry, options: RouteSpecOptions): void {
  const responses: RouteConfig["responses"] = {};
  for (const [status, response] of Object.entries(options.responses)) {
    responses[Number(status)] = response.schema
      ? { description: response.description, content: { "application/json": { schema: response.schema } } }
      : { description: response.description };
  }

  const security = securityFor(options.auth);
  registry.registerPath({
    method: options.method,
    path: toSpecPath(options.path),
    request: {
      ...(pathParameters(options.path) ?? {}),
      ...(options.request?.body ? { body: { content: { "application/json": { schema: options.request.body } } } } : {}),
      ...(options.request?.query ? { query: options.request.query } : {}),
    },
    operationId: options.operationId,
    tags: options.tags,
    summary: options.summary,
    ...(options.description ? { description: options.description } : {}),
    ...(security ? { security } : {}),
    ...(options.request?.body || options.request?.query
      ? {
          request: {
            ...(options.request.body ? { body: { content: { "application/json": { schema: options.request.body } } } } : {}),
            ...(options.request.query ? { query: options.request.query } : {}),
          },
        }
      : {}),
    responses,
  });
}
