import { beforeEach, describe, expect, it, vi } from "vitest";

// #8389: `build()` runs at module-import time against the committed public/openapi.json, and neither it
// nor slugify/extractPathParams/extractExample is exported. So the spec module is mocked with a small
// hand-built fixture and openapi.ts is imported dynamically per test — the committed spec's real
// contents drift with every API change and must never be what these assertions depend on. getApiOrigin
// is mocked too so normalizeServers' rewrite is asserted against a fixed, deterministic origin.
const FIXTURE_ORIGIN = "https://api.fixture.test";

vi.mock("./api/origin", () => ({ getApiOrigin: () => FIXTURE_ORIGIN }));

const RAW_SPEC = {
  info: { title: "Fixture API", version: "9.9.9", description: "Fixture description" },
  servers: [
    { url: "https://baked-in-at-generation-time.example", description: "Production" },
    { url: "https://second.example", description: "Secondary" },
  ],
  tags: [{ name: "Repos", description: "Repo operations" }],
  paths: {
    "/v1/repos/{owner}/{repo}": {
      get: {
        tags: ["Repos"],
        summary: "Get a repo",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { example: { ok: true } } },
          },
        },
      },
    },
    // `{id}` IS declared explicitly, so it must not be auto-added a second time.
    "/v1/things/{id}": {
      post: {
        tags: ["Repos"],
        operationId: "createThing",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, description: "Declared by the author." },
        ],
        responses: {
          "201": {
            description: "Created",
            // No `example`, so the first `examples` entry is used instead.
            content: {
              "application/json": { examples: { first: { value: 1 }, second: { value: 2 } } },
            },
          },
          "204": { description: "No content" }, // no content entry at all -> undefined
        },
      },
    },
    // Tag never declared in `raw.tags` -> exercises build()'s undeclared-tag fallback group.
    "/v1/undeclared": {
      delete: { tags: ["Ghost"], responses: {} },
    },
  },
};

vi.mock("../../public/openapi.json", () => ({ default: RAW_SPEC }));

type OpenApiModule = typeof import("./openapi");
let mod: OpenApiModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./openapi");
});

describe("build() — operation ids and slugify (#8389)", () => {
  it("slugifies method+path into the id every /api/$op URL is keyed on, stripping braces", () => {
    const op = mod.openapi.operations.find((o) => o.path === "/v1/repos/{owner}/{repo}");
    expect(op?.id).toBe("get-v1-repos-owner-repo");
    // No leading/trailing dashes, and no run of consecutive dashes survived the collapse.
    expect(op?.id).not.toMatch(/^-|-$|--/);
  });

  it("findOperation resolves an operation by that id, and returns undefined for an unknown one", () => {
    expect(mod.findOperation("get-v1-repos-owner-repo")?.path).toBe("/v1/repos/{owner}/{repo}");
    expect(mod.findOperation("no-such-operation")).toBeUndefined();
  });

  it("defaults the summary to METHOD + path when the spec declares none, and carries operationId through", () => {
    const declared = mod.findOperation("get-v1-repos-owner-repo");
    expect(declared?.summary).toBe("Get a repo");
    const undeclared = mod.openapi.operations.find((o) => o.path === "/v1/undeclared");
    expect(undeclared?.summary).toBe("DELETE /v1/undeclared");
    expect(mod.openapi.operations.find((o) => o.path === "/v1/things/{id}")?.operationId).toBe(
      "createThing",
    );
  });
});

describe("extractPathParams (#8389)", () => {
  it("auto-adds an undeclared {param} as a required path parameter", () => {
    const params = mod.findOperation("get-v1-repos-owner-repo")?.parameters ?? [];
    expect(params).toEqual([
      {
        name: "owner",
        in: "path",
        required: true,
        description: "Value for {owner} in /v1/repos/{owner}/{repo}.",
        schema: { type: "string" },
      },
      {
        name: "repo",
        in: "path",
        required: true,
        description: "Value for {repo} in /v1/repos/{owner}/{repo}.",
        schema: { type: "string" },
      },
    ]);
  });

  it("never duplicates a {param} the spec already declares — the author's description wins", () => {
    const params =
      mod.openapi.operations.find((o) => o.path === "/v1/things/{id}")?.parameters ?? [];
    expect(params.filter((p) => p.name === "id")).toHaveLength(1);
    expect(params[0]?.description).toBe("Declared by the author.");
  });
});

describe("extractExample (#8389)", () => {
  it("prefers `example`, falls back to the first `examples` entry, and is undefined without JSON content", () => {
    expect(mod.findOperation("get-v1-repos-owner-repo")?.responses["200"]?.example).toEqual({
      ok: true,
    });
    const thing = mod.openapi.operations.find((o) => o.path === "/v1/things/{id}");
    // The fallback unwraps the OpenAPI `examples` envelope: the first entry's `.value`, not the entry.
    expect(thing?.responses["201"]?.example).toBe(1);
    expect(thing?.responses["204"]?.example).toBeUndefined(); // no application/json content
  });

  it("produces no response entries at all for an operation with an empty `responses` object", () => {
    expect(mod.openapi.operations.find((o) => o.path === "/v1/undeclared")?.responses).toEqual({});
  });
});

describe("tag grouping (#8389)", () => {
  it("keeps declared tags with their description and appends a group for any undeclared tag", () => {
    const declared = mod.openapi.tags.find((t) => t.name === "Repos");
    expect(declared?.description).toBe("Repo operations");
    expect(declared?.operations.map((o) => o.path).sort()).toEqual([
      "/v1/repos/{owner}/{repo}",
      "/v1/things/{id}",
    ]);
    // "Ghost" is never in raw.tags — build()'s fallback loop must still surface it.
    const fallback = mod.openapi.tags.find((t) => t.name === "Ghost");
    expect(fallback).toBeDefined();
    expect(fallback?.description).toBeUndefined();
    expect(fallback?.operations.map((o) => o.path)).toEqual(["/v1/undeclared"]);
  });
});

describe("normalizeServers (#8389)", () => {
  it("overwrites the first server's url with the live API origin, leaving later servers untouched", () => {
    expect(mod.openapi.servers[0]).toEqual({ url: FIXTURE_ORIGIN, description: "Production" });
    expect(mod.openapi.servers[1]).toEqual({
      url: "https://second.example",
      description: "Secondary",
    });
  });

  it("carries the spec's info fields through", () => {
    expect(mod.openapi.title).toBe("Fixture API");
    expect(mod.openapi.version).toBe("9.9.9");
    expect(mod.openapi.description).toBe("Fixture description");
  });
});

describe("code-sample generators (#8389)", () => {
  const server = "https://api.example.com/"; // trailing slash must be stripped

  it("generateCurl: omits the auth header for an unauthenticated GET and sends no body", () => {
    const op = mod.findOperation("get-v1-repos-owner-repo")!;
    const curl = mod.generateCurl(op, server);
    expect(curl).toContain("curl -X GET 'https://api.example.com/v1/repos/{owner}/{repo}'");
    expect(curl).not.toContain("Authorization");
    expect(curl).not.toContain("-d '{}'");
  });

  it("generateCurl: adds the bearer header for an authenticated POST, with a body, and inlines a supplied token", () => {
    const op = mod.openapi.operations.find((o) => o.path === "/v1/things/{id}")!;
    expect(mod.generateCurl(op, server)).toContain("-H 'Authorization: Bearer $LOOPOVER_TOKEN'");
    expect(mod.generateCurl(op, server, "tok-123")).toContain("-H 'Authorization: Bearer tok-123'");
    expect(mod.generateCurl(op, server)).toContain("-d '{}'");
  });

  it("generateFetch / generatePython: branch on auth and on whether the method takes a body", () => {
    const get = mod.findOperation("get-v1-repos-owner-repo")!;
    const post = mod.openapi.operations.find((o) => o.path === "/v1/things/{id}")!;

    const getFetch = mod.generateFetch(get, server);
    expect(getFetch).toContain("await fetch('https://api.example.com/v1/repos/{owner}/{repo}'");
    expect(getFetch).toContain("method: 'GET'");
    expect(getFetch).not.toContain("Authorization");
    expect(getFetch).not.toContain("body:");

    const postFetch = mod.generateFetch(post, server);
    expect(postFetch).toContain("'Authorization': `Bearer ${token}`");
    expect(postFetch).toContain("body: JSON.stringify({})");

    const getPython = mod.generatePython(get, server);
    expect(getPython).toContain(
      "res = httpx.get('https://api.example.com/v1/repos/{owner}/{repo}'",
    );
    expect(getPython).not.toContain("Authorization");
    expect(getPython).not.toContain("json={}");

    const postPython = mod.generatePython(post, server);
    expect(postPython).toContain("'Authorization': f'Bearer {token}'");
    expect(postPython).toContain("json={}");
  });

  it("DELETE is body-less like GET in every generator", () => {
    const del = mod.openapi.operations.find((o) => o.path === "/v1/undeclared")!;
    expect(mod.generateCurl(del, server)).not.toContain("-d '{}'");
    expect(mod.generateFetch(del, server)).not.toContain("body:");
    expect(mod.generatePython(del, server)).not.toContain("json={}");
  });
});
