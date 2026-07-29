import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AmsCycleScheduleRequestSchema,
  CONTROL_PLANE_ROUTES,
  CreateTenantRequestSchema,
  HOSTED_CYCLE_COMMANDS,
  OrbInstallationIdSchema,
  TENANT_LIFECYCLE_STATES,
  TenantListResponseSchema,
  TenantRecordSchema,
} from "@loopover/contract/control-plane";
import { HOSTED_CYCLE_COMMANDS as MINER_HOSTED_CYCLE_COMMANDS } from "../../packages/loopover-miner/lib/hosted-entry";
import { buildControlPlaneSpec } from "../../scripts/gen-control-plane-openapi";
import { render } from "../../scripts/gen-control-plane-contract";

// #9750: the control plane was the one surface here with NO machine-readable contract -- no zod, no spec,
// its only description prose plus the hardcoded fetches in the miner's admin client. These pin the three
// properties that make the new contract worth having: the Worker validates against it, the document is
// generated from it, and the mirror the Worker imports cannot drift from it.

describe("the route table describes the whole surface (#9750)", () => {
  it("covers every route control-plane/src/http-app.ts registers", () => {
    // Read out of the app rather than restated: a route added there without an entry here would otherwise
    // be served and undocumented, which is the state this issue exists to end.
    const source = readFileSync("control-plane/src/http-app.ts", "utf8");
    const registered = [...source.matchAll(/\bapp\.(get|post|patch|delete)\("([^"]+)"/g)].map((match) => `${match[1]!} ${match[2]!}`).sort();
    const tabled = CONTROL_PLANE_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
    expect(tabled).toEqual(registered);
  });

  it("gives every route a stable operationId and at least one response", () => {
    const ids = CONTROL_PLANE_ROUTES.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const route of CONTROL_PLANE_ROUTES) expect(Object.keys(route.responses).length).toBeGreaterThan(0);
  });

  it("puts the admin bearer on the tenant surface and NOT on the webhook", () => {
    // The webhook is deliberately outside the admin middleware: GitHub authenticates it with an HMAC over
    // the raw body, so demanding the admin token there would describe a gate that does not exist.
    const byPath = new Map(CONTROL_PLANE_ROUTES.map((route) => [route.path, route.auth]));
    expect(byPath.get("/v1/tenants")).toBe("admin-bearer");
    expect(byPath.get("/v1/tenants/:name")).toBe("admin-bearer");
    expect(byPath.get("/v1/orb/webhook")).toBe("webhook-signature");
    expect(byPath.get("/health")).toBe("public");
  });

  it("declares the 503 that every admin route answers when no admin token is configured", () => {
    // Fails closed, and says so: an unconfigured deployment is a 503, not a 401 the caller would retry.
    for (const route of CONTROL_PLANE_ROUTES.filter((entry) => entry.auth === "admin-bearer")) {
      expect(Object.keys(route.responses), `${route.operationId}`).toEqual(expect.arrayContaining(["401", "503"]));
    }
  });
});

describe("the generated document (#9750)", () => {
  const spec = buildControlPlaneSpec() as {
    paths: Record<string, Record<string, { operationId?: string; security?: unknown; responses?: Record<string, unknown> }>>;
    components?: { securitySchemes?: Record<string, { name?: string; scheme?: string }> };
  };

  it("matches the committed control-plane/openapi.json", () => {
    expect(`${JSON.stringify(spec, null, 2)}\n`).toBe(readFileSync("control-plane/openapi.json", "utf8"));
  });

  it("templates the path parameter rather than publishing a literal :name", () => {
    expect(spec.paths["/v1/tenants/{name}"]).toBeDefined();
    expect(spec.paths["/v1/tenants/:name"]).toBeUndefined();
    expect(spec.paths["/v1/tenants/{name}"]!.delete!.responses).toBeDefined();
  });

  it("never leaves a 401-declaring operation without a scheme", () => {
    // The #9707 lesson, applied to a surface being specced for the first time.
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (operation?.responses?.["401"]) expect(operation.security, `${method.toUpperCase()} ${path}`).not.toBeUndefined();
      }
    }
  });

  it("names the header GitHub actually signs with", () => {
    expect(spec.components?.securitySchemes?.GitHubWebhookSignature?.name).toBe("x-hub-signature-256");
    expect(spec.components?.securitySchemes?.ControlPlaneAdminBearer?.scheme).toBe("bearer");
  });
});

describe("the mirror the Worker imports cannot drift (#9750)", () => {
  it("is byte-identical to the contract module plus its generated header", () => {
    // control-plane/ is not a workspace member and installs separately, so it reads a generated copy rather
    // than importing the package. The copy is only safe because this fails the moment they differ.
    const source = readFileSync("packages/loopover-contract/src/control-plane.ts", "utf8");
    expect(readFileSync("control-plane/src/generated/control-plane-contract.ts", "utf8")).toBe(render(source));
  });

  it("marks the copy as generated so nobody edits it by hand", () => {
    const mirror = readFileSync("control-plane/src/generated/control-plane-contract.ts", "utf8");
    expect(mirror.startsWith("// GENERATED by")).toBe(true);
    expect(mirror).toContain("npm run control-plane:contract");
  });
});

describe("the schemas accept what the routes accept and reject what they reject (#9750)", () => {
  it("requires a non-blank name and product on create", () => {
    expect(CreateTenantRequestSchema.safeParse({ name: "acme", product: "ams" }).success).toBe(true);
    expect(CreateTenantRequestSchema.safeParse({ name: "   ", product: "ams" }).success).toBe(false);
    expect(CreateTenantRequestSchema.safeParse({ name: "acme" }).success).toBe(false);
  });

  it("takes an installation ID only as a positive integer, matching GitHub's own ID space", () => {
    expect(OrbInstallationIdSchema.safeParse(12345).success).toBe(true);
    for (const bad of [0, -1, 1.5, "12345", null]) expect(OrbInstallationIdSchema.safeParse(bad).success, String(bad)).toBe(false);
  });

  it("accepts a schedule with args omitted, and rejects a command outside the hosted set", () => {
    expect(AmsCycleScheduleRequestSchema.safeParse({ command: "attempt", intervalMs: 1000 }).success).toBe(true);
    expect(AmsCycleScheduleRequestSchema.safeParse({ command: "rm-rf", intervalMs: 1000 }).success).toBe(false);
    expect(AmsCycleScheduleRequestSchema.safeParse({ command: "attempt", intervalMs: 0 }).success).toBe(false);
  });

  it("keeps the hosted command list identical to the miner's own dispatcher", () => {
    // Both used to be plain literals in two packages, with comments pointing at each other and nothing
    // checking. Compared against the DISPATCHER itself -- the object whose keys decide what a hosted
    // container will actually run -- rather than against a copy of the list.
    expect([...HOSTED_CYCLE_COMMANDS].sort()).toEqual(Object.keys(MINER_HOSTED_CYCLE_COMMANDS).sort());
  });

  it("parses a tenant record as the routes project it, and rejects one missing its identity", () => {
    const record = { tenant: { name: "acme" }, product: "ams", state: "active" as const };
    expect(TenantRecordSchema.safeParse(record).success).toBe(true);
    expect(TenantRecordSchema.safeParse({ product: "ams", state: "active" }).success).toBe(false);
    expect(TenantRecordSchema.safeParse({ ...record, state: "exploded" }).success).toBe(false);
  });

  it("stays open to a field it has never seen — an output schema is a floor, not a fence", () => {
    const parsed = TenantRecordSchema.safeParse({ tenant: { name: "acme" }, product: "ams", state: "active", futureField: 1 });
    expect(parsed.success && (parsed.data as Record<string, unknown>).futureField).toBe(1);
  });

  it("requires the timestamps on a list entry that the single-record projection omits", () => {
    const entry = { tenant: { name: "acme" }, product: "ams", state: "active" as const };
    expect(TenantListResponseSchema.safeParse({ tenants: [entry] }).success).toBe(false);
    expect(TenantListResponseSchema.safeParse({ tenants: [{ ...entry, createdAt: "x", updatedAt: "y" }] }).success).toBe(true);
  });

  it("covers every lifecycle state the control plane can report", () => {
    for (const state of TENANT_LIFECYCLE_STATES) {
      expect(TenantRecordSchema.safeParse({ tenant: { name: "a" }, product: "ams", state }).success, state).toBe(true);
    }
  });
});
