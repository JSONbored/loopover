#!/usr/bin/env node
// Generates control-plane/openapi.json from the CONTROL_PLANE_ROUTES table (#9750).
//
// The hosted control plane was the one surface in this repo with no machine-readable contract at all: no
// zod, no spec, its only description prose plus the hardcoded fetches in
// packages/loopover-miner/lib/tenant-client.ts. Now the same table the Worker registers its routes from
// emits the document, so neither can describe a route the other does not serve.
//
// `--check` regenerates in memory and diffs, exiting 1 on drift; test:ci runs it, exactly like
// ui:openapi:check does for the main API.
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { CONTROL_PLANE_ROUTES, type ControlPlaneAuth } from "@loopover/contract/control-plane";

extendZodWithOpenApi(z);

const TARGET = "control-plane/openapi.json";

/**
 * Each auth level's security stanza.
 *
 * `[]`, not undefined, for the webhook and health routes -- an empty array is OpenAPI's explicit "needs no
 * LoopOver credential", where an absent one means "not stated". The webhook genuinely needs no credential
 * of this service's: GitHub authenticates it with an HMAC over the raw body, which is a scheme rather than
 * a bearer, and #9707 is the cautionary case for publishing a 401 with nothing that could produce it.
 */
function securityFor(auth: ControlPlaneAuth): Array<Record<string, string[]>> {
  if (auth === "admin-bearer") return [{ ControlPlaneAdminBearer: [] }];
  if (auth === "webhook-signature") return [{ GitHubWebhookSignature: [] }];
  return [];
}

/** `:name` -> `{name}`, so the document templates what Hono routes. */
function toSpecPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Every `:param` as an `in: path` parameter. Derived from the path, never declared twice. */
function pathParameters(path: string): { params: z.ZodObject } | undefined {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  if (names.length === 0) return undefined;
  return { params: z.object(Object.fromEntries(names.map((name) => [name, z.string()]))) };
}

export function buildControlPlaneSpec(): Record<string, unknown> {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "ControlPlaneAdminBearer", {
    type: "http",
    scheme: "bearer",
    description: "The control plane's own admin token. Distinct from any tenant's per-instance secrets and from a LoopOver API token.",
  });
  registry.registerComponent("securitySchemes", "GitHubWebhookSignature", {
    type: "apiKey",
    in: "header",
    name: "x-hub-signature-256",
    description: "GitHub's HMAC-SHA256 over the raw request body, verified against the hosted fleet's own App webhook secret.",
  });

  for (const route of CONTROL_PLANE_ROUTES) {
    const responses: Record<number, unknown> = {};
    for (const [status, response] of Object.entries(route.responses)) {
      responses[Number(status)] = response.schema
        ? { description: response.description, content: { "application/json": { schema: response.schema } } }
        : { description: response.description };
    }
    registry.registerPath({
      method: route.method,
      path: toSpecPath(route.path),
      operationId: route.operationId,
      tags: ["Control plane"],
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      security: securityFor(route.auth),
      request: {
        ...(pathParameters(route.path) ?? {}),
        ...(route.request?.body ? { body: { content: { "application/json": { schema: route.request.body } } } } : {}),
        ...(route.request?.query ? { query: route.request.query } : {}),
      },
      responses: responses as never,
    });
  }

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "LoopOver control plane",
      version: "0.1.0",
      description: "Tenant provisioning for the hosted ORB + AMS fleet. Admin-only, apart from the GitHub webhook ingress.",
    },
  }) as unknown as Record<string, unknown>;
}

function main(argv: readonly string[]): void {
  const check = argv.includes("--check");
  const path = join(process.cwd(), TARGET);
  const next = `${JSON.stringify(buildControlPlaneSpec(), null, 2)}\n`;

  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Missing is generated fresh, and is drift under --check.
  }

  if (next === current) {
    process.stdout.write(`gen-control-plane-openapi: ${TARGET} is up to date (${CONTROL_PLANE_ROUTES.length} routes).\n`);
    return;
  }
  if (check) {
    process.stderr.write(`gen-control-plane-openapi: ${TARGET} is stale -- run \`npm run control-plane:openapi\`.\n`);
    process.exit(1);
  }
  writeFileSync(path, next);
  process.stdout.write(`gen-control-plane-openapi: wrote ${TARGET} (${CONTROL_PLANE_ROUTES.length} routes).\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
