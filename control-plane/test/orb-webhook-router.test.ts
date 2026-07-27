// Tests for #7181's request-time webhook routing. No live Cloudflare Containers anywhere here --
// RouterNamespaceLike/RouterStubLike are hand-rolled fakes, mirroring ams-wake.test.ts's own convention.
// Real GitHub HMAC-SHA256 signatures are computed with node:crypto (a different implementation from
// orb-webhook-router.ts's own Web-Crypto-based verifier) so a passing test proves interop, not just that both
// sides agree with themselves.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { createFakeTenantRegistry, routeOrbWebhook, type OrbWebhookRouterConfig, type RouterNamespaceLike, type RouterStubLike, type TenantRegistry } from "../dist/index.js";

const WEBHOOK_SECRET = "test-webhook-secret";

function githubSignature(rawBody: string, secret: string = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function webhookRequest(body: unknown, options: { signature?: string; secret?: string } = {}): Request {
  const rawBody = JSON.stringify(body);
  const signature = options.signature ?? githubSignature(rawBody, options.secret);
  return new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-event": "pull_request" },
    body: rawBody,
  });
}

function fakeStub(response: Response | (() => Response)): RouterStubLike & { requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    async fetch(request) {
      requests.push(request);
      return typeof response === "function" ? response() : response;
    },
  };
}

function fakeNamespace(stubs: Record<string, RouterStubLike>): RouterNamespaceLike & { requestedNames: string[] } {
  const requestedNames: string[] = [];
  return {
    requestedNames,
    getByName(name) {
      requestedNames.push(name);
      const stub = stubs[name];
      if (!stub) throw new Error(`fakeNamespace: no stub registered for "${name}"`);
      return stub;
    },
  };
}

function baseConfig(overrides: Partial<OrbWebhookRouterConfig> & { registry: TenantRegistry }): OrbWebhookRouterConfig {
  return { binding: fakeNamespace({}), webhookSecret: WEBHOOK_SECRET, ...overrides };
}

function streamBody(chunk: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

// #9143 (defect 6): this route used to buffer an UNBOUNDED body TWICE (a `.clone()` plus a `request.text()`)
// before ever checking the signature -- no content-length precheck, no streaming limit at all -- even though
// it sits OUTSIDE the admin Bearer wall (its declared twin, src/orb/webhook.ts#handleOrbWebhook, has both,
// governed by GITHUB_WEBHOOK_MAX_BODY_BYTES, fixed there by #8888). `maxBodyBytes` overrides keep these tests
// fast/deterministic without allocating megabyte-sized strings.
test("routeOrbWebhook: a Content-Length exceeding maxBodyBytes is rejected (413) before ever reading the body", async () => {
  const registry = createFakeTenantRegistry();
  let lookups = 0;
  const spiedRegistry: TenantRegistry = { ...registry, getByOrbInstallationId: (id) => { lookups += 1; return registry.getByOrbInstallationId(id); } };
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "content-length": "1000", "x-hub-signature-256": githubSignature("ignored") },
    body: "ignored",
  });

  const response = await routeOrbWebhook(baseConfig({ registry: spiedRegistry, maxBodyBytes: 10 }), request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "payload_too_large", maxBytes: 10 });
  assert.equal(lookups, 0);
});

test("routeOrbWebhook: a body exceeding maxBodyBytes with NO Content-Length header is still rejected (413) via the streaming limit", async () => {
  const registry = createFakeTenantRegistry();
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": githubSignature("ignored") },
    body: streamBody("a".repeat(20)),
    duplex: "half",
  } as RequestInit);

  const response = await routeOrbWebhook(baseConfig({ registry, maxBodyBytes: 10 }), request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "payload_too_large", maxBytes: 10 });
});

test("routeOrbWebhook: a non-numeric Content-Length header is ignored by the precheck, falling through to the streaming limit", async () => {
  const registry = createFakeTenantRegistry();
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "content-length": "not-a-number", "x-hub-signature-256": githubSignature("ignored") },
    body: "ignored",
  });

  const response = await routeOrbWebhook(baseConfig({ registry, maxBodyBytes: 10_000 }), request);

  // Not rejected by the (skipped) precheck -- the correctly-signed body verifies fine and proceeds all the way
  // to the (non-JSON) payload check, proving the malformed header didn't crash or silently reject anything.
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("routeOrbWebhook: a Content-Length of '0' parses to null (not a positive int), falling through to the streaming limit", async () => {
  const registry = createFakeTenantRegistry();
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "content-length": "0", "x-hub-signature-256": githubSignature("ignored") },
    body: "ignored",
  });

  const response = await routeOrbWebhook(baseConfig({ registry, maxBodyBytes: 10_000 }), request);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("routeOrbWebhook: an absent request body reads as an empty string, not null (no stream to read)", async () => {
  const registry = createFakeTenantRegistry();
  const request = new Request("https://control-plane.example/v1/orb/webhook", { method: "POST" });

  const response = await routeOrbWebhook(baseConfig({ registry, maxBodyBytes: 10_000 }), request);

  // Empty body verifies against an empty signature only if the secret matches an empty string's HMAC -- here
  // it won't, so this proves readBodyWithLimit's `!stream` branch returns "" rather than throwing.
  assert.equal(response.status, 401);
});

test("routeOrbWebhook: skips undefined stream chunks while reading the body", async () => {
  const registry = createFakeTenantRegistry();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(undefined as unknown as Uint8Array);
      controller.close();
    },
  });
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=bad" },
    body: stream,
    duplex: "half",
  } as RequestInit);

  const response = await routeOrbWebhook(baseConfig({ registry, maxBodyBytes: 10_000 }), request);

  assert.equal(response.status, 401); // empty (undefined-skipped) body + bad sig
});

test("routeOrbWebhook: a body within maxBodyBytes is processed normally", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 42 });
  const containerResponse = Response.json({ ok: true }, { status: 202 });
  const binding = fakeNamespace({ "orb:acme": fakeStub(containerResponse) });
  const request = webhookRequest({ installation: { id: 42 } });

  const response = await routeOrbWebhook(baseConfig({ registry, binding, maxBodyBytes: 10_000 }), request);

  assert.equal(response.status, 202);
});

test("routeOrbWebhook: a missing x-hub-signature-256 header is rejected (401), no registry lookup happens", async () => {
  const registry = createFakeTenantRegistry();
  let lookups = 0;
  const spiedRegistry: TenantRegistry = {
    ...registry,
    getByOrbInstallationId(id) {
      lookups += 1;
      return registry.getByOrbInstallationId(id);
    },
  };
  const request = new Request("https://control-plane.example/v1/orb/webhook", { method: "POST", body: JSON.stringify({ installation: { id: 1 } }) });

  const response = await routeOrbWebhook(baseConfig({ registry: spiedRegistry }), request);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_signature" });
  assert.equal(lookups, 0);
});

test("routeOrbWebhook: a signature that doesn't match the body is rejected (401)", async () => {
  const registry = createFakeTenantRegistry();
  const request = webhookRequest({ installation: { id: 1 } }, { signature: "sha256=" + "0".repeat(64) });

  const response = await routeOrbWebhook(baseConfig({ registry }), request);

  assert.equal(response.status, 401);
});

test("routeOrbWebhook: a signature missing the sha256= prefix is rejected (401)", async () => {
  const registry = createFakeTenantRegistry();
  const rawBody = JSON.stringify({ installation: { id: 1 } });
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex") },
    body: rawBody,
  });

  const response = await routeOrbWebhook(baseConfig({ registry }), request);

  assert.equal(response.status, 401);
});

for (const [label, malformedHex] of [
  ["non-hex characters", "not-hex-at-all"],
  ["odd length", "abc"],
  ["empty", ""],
  ["valid hex but the wrong length", "abcd"],
] as const) {
  test(`routeOrbWebhook: a signature with ${label} is rejected (401)`, async () => {
    const registry = createFakeTenantRegistry();
    const request = webhookRequest({ installation: { id: 1 } }, { signature: `sha256=${malformedHex}` });

    const response = await routeOrbWebhook(baseConfig({ registry }), request);

    assert.equal(response.status, 401);
  });
}

test("routeOrbWebhook: an unset webhookSecret fails every delivery closed (401), even with a well-formed signature", async () => {
  const registry = createFakeTenantRegistry();
  const request = webhookRequest({ installation: { id: 1 } });

  const response = await routeOrbWebhook(baseConfig({ registry, webhookSecret: undefined }), request);

  assert.equal(response.status, 401);
});

test("routeOrbWebhook: a verified but non-JSON body is rejected (400)", async () => {
  const registry = createFakeTenantRegistry();
  const rawBody = "not json";
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": githubSignature(rawBody) },
    body: rawBody,
  });

  const response = await routeOrbWebhook(baseConfig({ registry }), request);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("routeOrbWebhook: a verified payload missing installation.id is rejected (400)", async () => {
  const registry = createFakeTenantRegistry();
  const request = webhookRequest({ action: "opened" });

  const response = await routeOrbWebhook(baseConfig({ registry }), request);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "missing_installation_id" });
});

test("routeOrbWebhook: an installation ID no tenant has claimed is rejected (404), no container is touched", async () => {
  const registry = createFakeTenantRegistry();
  const binding = fakeNamespace({});
  const request = webhookRequest({ installation: { id: 42 } });

  const response = await routeOrbWebhook(baseConfig({ registry, binding }), request);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "unknown_installation" });
  assert.deepEqual(binding.requestedNames, []);
});

test("routeOrbWebhook: a torn-down tenant's installation ID is rejected (404) even though it's still indexed", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "torn down", createdAt: "t0", updatedAt: "t0", orbInstallationId: 42 });

  const response = await routeOrbWebhook(baseConfig({ registry }), webhookRequest({ installation: { id: 42 } }));

  assert.equal(response.status, 404);
});

test("routeOrbWebhook: an installation ID somehow indexed against a non-ORB tenant is rejected (404)", async () => {
  const registry = createFakeTenantRegistry();
  // Defensive-only case: only ORB tenants are ever meant to carry orbInstallationId, but the registry itself
  // doesn't enforce that -- this proves the router doesn't blindly trust the index.
  await registry.upsert({ tenant: { name: "acme" }, product: "ams", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 42 });

  const response = await routeOrbWebhook(baseConfig({ registry }), webhookRequest({ installation: { id: 42 } }));

  assert.equal(response.status, 404);
});

test("routeOrbWebhook: forwards a verified webhook to the claiming tenant's container and returns its response unmodified", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 42 });
  const containerResponse = Response.json({ ok: true, deliveryId: "abc", status: "received" }, { status: 202 });
  const stub = fakeStub(containerResponse);
  const binding = fakeNamespace({ "orb:acme": stub });
  const rawBody = JSON.stringify({ installation: { id: 42 }, action: "opened" });
  const request = new Request("https://control-plane.example/v1/orb/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": githubSignature(rawBody), "x-github-event": "pull_request" },
    body: rawBody,
  });

  const response = await routeOrbWebhook(baseConfig({ registry, binding }), request);

  assert.deepEqual(binding.requestedNames, ["orb:acme"]);
  assert.equal(stub.requests.length, 1);
  assert.equal(await stub.requests[0]!.text(), rawBody);
  assert.equal(stub.requests[0]!.headers.get("x-github-event"), "pull_request");
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, deliveryId: "abc", status: "received" });
});

test("routeOrbWebhook: a container that throws while waking/fetching is answered with 502, not a crash", async () => {
  const registry = createFakeTenantRegistry();
  await registry.upsert({ tenant: { name: "acme" }, product: "orb", state: "active", createdAt: "t0", updatedAt: "t0", orbInstallationId: 42 });
  const stub: RouterStubLike = {
    async fetch() {
      throw new Error("container unreachable");
    },
  };
  const binding = fakeNamespace({ "orb:acme": stub });

  const response = await routeOrbWebhook(baseConfig({ registry, binding }), webhookRequest({ installation: { id: 42 } }));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "container_unreachable" });
});
