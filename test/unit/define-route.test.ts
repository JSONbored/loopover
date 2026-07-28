// Tests for the route-registration seam (#9519).
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { defineRoute, invalidRequestBody, registerRouteSpec } from "../../src/openapi/define-route";

type TestEnv = { Bindings: Record<string, unknown>; Variables: Record<string, unknown> };

function build() {
  return { app: new Hono<TestEnv>(), registry: new OpenAPIRegistry() };
}

function generate(registry: OpenAPIRegistry) {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
  });
}

describe("defineRoute", () => {
  it("registers the route on the app and serves the handler", async () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "get",
      path: "/v1/thing",
      operationId: "getThing",
      tags: ["things"],
      summary: "Get a thing",
      auth: "public",
      responses: { 200: { description: "ok", schema: z.object({ ok: z.boolean() }) } },
    }, (c) => c.json({ ok: true }));

    const response = await app.request("/v1/thing");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("emits an operation with the operationId, tags, and summary", () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "get",
      path: "/v1/thing",
      operationId: "getThing",
      tags: ["things"],
      summary: "Get a thing",
      description: "Longer prose",
      auth: "public",
      responses: { 200: { description: "ok" } },
    }, (c) => c.json({}));

    const operation = generate(registry).paths?.["/v1/thing"]?.get;
    expect(operation?.operationId).toBe("getThing");
    expect(operation?.tags).toEqual(["things"]);
    expect(operation?.summary).toBe("Get a thing");
    expect(operation?.description).toBe("Longer prose");
  });

  it("rewrites Hono path params into OpenAPI form for the document while serving the Hono path", async () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "get",
      path: "/v1/repos/:owner/:repo",
      operationId: "getRepo",
      tags: ["repos"],
      summary: "Get repo",
      auth: "token",
      responses: { 200: { description: "ok" } },
    }, (c) => c.json({ owner: c.req.param("owner") }));

    expect(generate(registry).paths?.["/v1/repos/{owner}/{repo}"]).toBeDefined();
    expect(await (await app.request("/v1/repos/a/b")).json()).toEqual({ owner: "a" });
  });

  it("validates the request body and hands the handler parsed data", async () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "post",
      path: "/v1/thing",
      operationId: "createThing",
      tags: ["things"],
      summary: "Create",
      auth: "token",
      request: { body: z.object({ name: z.string().min(1) }) },
      responses: { 200: { description: "ok" } },
    }, (c, { body }) => c.json({ name: body.name }));

    const ok = await app.request("/v1/thing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(await ok.json()).toEqual({ name: "x" });
  });

  it("rejects an invalid body with a 400 in the repo's existing error shape", async () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "post",
      path: "/v1/thing",
      operationId: "createThing",
      tags: ["things"],
      summary: "Create",
      auth: "token",
      request: { body: z.object({ name: z.string().min(1) }) },
      responses: { 200: { description: "ok" } },
    }, (c) => c.json({ unreachable: true }));

    const bad = await app.request("/v1/thing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_createThing_request" });
  });

  it("treats an unparseable body as a 400 rather than letting it throw a 500", async () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "post",
      path: "/v1/thing",
      operationId: "createThing",
      tags: ["things"],
      summary: "Create",
      auth: "token",
      request: { body: z.object({ name: z.string() }) },
      responses: { 200: { description: "ok" } },
    }, (c) => c.json({ unreachable: true }));

    const bad = await app.request("/v1/thing", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
    expect(bad.status).toBe(400);
  });

  it("validates query params and rejects an invalid one", async () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "get",
      path: "/v1/thing",
      operationId: "listThings",
      tags: ["things"],
      summary: "List",
      auth: "token",
      request: { query: z.object({ limit: z.coerce.number().int().positive() }) },
      responses: { 200: { description: "ok" } },
    }, (c, { query }) => c.json({ limit: query.limit }));

    expect(await (await app.request("/v1/thing?limit=5")).json()).toEqual({ limit: 5 });
    expect((await app.request("/v1/thing?limit=nope")).status).toBe(400);
  });

  it("declares an empty security stanza for public routes and requires credentials otherwise", () => {
    const { app, registry } = build();
    for (const [auth, path, id] of [
      ["public", "/v1/open", "openOp"],
      ["token", "/v1/tokened", "tokenOp"],
      ["session", "/v1/sessioned", "sessionOp"],
      ["internal", "/v1/internal/thing", "internalOp"],
    ] as const) {
      defineRoute(app, registry, { method: "get", path, operationId: id, tags: ["t"], summary: "s", auth, responses: { 200: { description: "ok" } } }, (c) => c.json({}));
    }
    const paths = generate(registry).paths ?? {};
    // `[]`, not undefined (#9531): an empty array is OpenAPI's explicit "no credential required",
    // where an absent one means "not stated". applySecurityMetadata fills in the legacy registerPath
    // calls that never declared anything, and it can only leave a deliberately public route alone if
    // that route says so out loud.
    expect(paths["/v1/open"]?.get?.security).toEqual([]);
    // Internal routes are bearer-only: no browser session ever reaches them.
    expect(paths["/v1/internal/thing"]?.get?.security).toEqual([{ LoopOverBearer: [] }]);
    for (const path of ["/v1/tokened", "/v1/sessioned"]) {
      expect(paths[path]?.get?.security).toEqual([{ LoopOverBearer: [] }, { LoopOverSessionCookie: [] }]);
    }
  });

  it("emits responses with and without a schema", () => {
    const { app, registry } = build();
    defineRoute(app, registry, {
      method: "get",
      path: "/v1/thing",
      operationId: "getThing",
      tags: ["things"],
      summary: "Get",
      auth: "public",
      responses: { 200: { description: "ok", schema: z.object({ a: z.string() }) }, 404: { description: "missing" } },
    }, (c) => c.json({}));

    const responses = generate(registry).paths?.["/v1/thing"]?.get?.responses ?? {};
    expect(responses["200"]).toHaveProperty("content");
    expect(responses["404"]).not.toHaveProperty("content");
  });
});

describe("registerRouteSpec", () => {
  it("contributes an operation without registering any route", () => {
    const registry = new OpenAPIRegistry();
    registerRouteSpec(registry, {
      method: "post",
      path: "/v1/spec-only/:id",
      operationId: "specOnly",
      tags: ["ops"],
      summary: "Spec only",
      auth: "internal",
      request: { body: z.object({ a: z.string() }) },
      responses: { 202: { description: "accepted" } },
    });
    const operation = generate(registry).paths?.["/v1/spec-only/{id}"]?.post;
    expect(operation?.operationId).toBe("specOnly");
    expect(operation?.requestBody).toBeDefined();
  });
});

describe("invalidRequestBody", () => {
  it("names the error after the operation and carries the zod issues", () => {
    const error = z.object({ a: z.string() }).safeParse({}).error!;
    expect(invalidRequestBody("createThing", error)).toMatchObject({ error: "invalid_createThing_request" });
    expect(Array.isArray(invalidRequestBody("createThing", error).issues)).toBe(true);
  });
});
