// Tests for the real secret driver against the main app's token broker (#8066). No live main-app deployment or
// live broker calls anywhere here -- `fetchImpl` is an injected stub (SecretDriverConfig's own test-only seam),
// mirroring ams-wake.ts's own fake-binding convention rather than neon-database-driver.test.ts's globalThis-stub
// one, since this driver's config already has a dedicated override point.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSecretDriver, injectTenantSecrets, revokeTenantSecrets, type DatabaseConnectionDetails, type SecretDriverConfig, type TenantProvisioningRequest } from "../dist/index.js";

const DATABASE: DatabaseConnectionDetails = {
  host: "fake-acme.control-plane.invalid",
  port: 5432,
  database: "acme",
  user: "acme",
  password: "fake-password-acme",
  connectionString: "postgres://acme:fake-password-acme@fake-acme.control-plane.invalid:5432/acme",
};

const REQUEST: TenantProvisioningRequest = { tenant: { name: "acme" }, product: "orb", database: DATABASE };

function fakeFetch(handler: (url: string, init: RequestInit) => Response): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function config(fetchImpl: typeof fetch): SecretDriverConfig {
  return { baseUrl: "https://api.loopover.test", internalJobToken: "internal-test-token", fetchImpl };
}

test("injectTenantSecrets: stores the database connection details JSON-encoded, returns enrollId as secretRef and the one-time secret as bootstrapSecret", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ enrollId: "orbenr_abc", secret: "orbsec_xyz" }, { status: 200 }));

  const result = await injectTenantSecrets(config(fetchImpl), REQUEST);

  assert.deepEqual(result, { secretRef: "orbenr_abc", bootstrapSecret: "orbsec_xyz" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.loopover.test/v1/internal/orb/enrollments");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer internal-test-token");
  const body = JSON.parse(calls[0]!.init.body as string) as { secretType: string; secretValue: string };
  assert.equal(body.secretType, "tenant_db_credential");
  const bundled = JSON.parse(body.secretValue) as { database: DatabaseConnectionDetails; orbWebhookSecret?: string };
  assert.deepEqual(bundled.database, DATABASE);
});

// #9143 (defect 5, deploy blocker): an ORB tenant's bundled enrollment ALSO carries a freshly generated
// webhook secret -- container-driver.ts's createTenantContainer never had a way to inject
// ORB_GITHUB_WEBHOOK_SECRET into a hosted tenant's container, so every correctly-signed GitHub delivery would
// 401 forever. Bundled into the SAME enrollment/bootstrapSecret as the database credential (see
// injectTenantSecrets' own doc comment for why), rather than a second one.
test("injectTenantSecrets: an ORB tenant's bundled payload also carries a freshly generated orbWebhookSecret (#9143)", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ enrollId: "orbenr_abc", secret: "orbsec_xyz" }));

  await injectTenantSecrets(config(fetchImpl), REQUEST);

  const body = JSON.parse(calls[0]!.init.body as string) as { secretValue: string };
  const bundled = JSON.parse(body.secretValue) as { database: DatabaseConnectionDetails; orbWebhookSecret?: string };
  assert.equal(typeof bundled.orbWebhookSecret, "string");
  assert.match(bundled.orbWebhookSecret!, /^[0-9a-f]{64}$/);
});

test("injectTenantSecrets: two ORB tenants get two DIFFERENT randomly generated webhook secrets, never a shared/hardcoded value (#9143)", async () => {
  const { fetchImpl: fetchA, calls: callsA } = fakeFetch(() => Response.json({ enrollId: "orbenr_a", secret: "orbsec_a" }));
  const { fetchImpl: fetchB, calls: callsB } = fakeFetch(() => Response.json({ enrollId: "orbenr_b", secret: "orbsec_b" }));

  await injectTenantSecrets(config(fetchA), { tenant: { name: "acme" }, product: "orb", database: DATABASE });
  await injectTenantSecrets(config(fetchB), { tenant: { name: "beta" }, product: "orb", database: DATABASE });

  const secretFor = (calls: typeof callsA) => {
    const body = JSON.parse(calls[0]!.init.body as string) as { secretValue: string };
    return (JSON.parse(body.secretValue) as { orbWebhookSecret?: string }).orbWebhookSecret;
  };
  const secretA = secretFor(callsA);
  const secretB = secretFor(callsB);
  assert.ok(secretA);
  assert.ok(secretB);
  assert.notEqual(secretA, secretB);
});

test("injectTenantSecrets: an AMS tenant's bundled payload never carries an orbWebhookSecret (its image never verifies a webhook)", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ enrollId: "orbenr_abc", secret: "orbsec_xyz" }));

  await injectTenantSecrets(config(fetchImpl), { tenant: { name: "acme" }, product: "ams", database: DATABASE });

  const body = JSON.parse(calls[0]!.init.body as string) as { secretValue: string };
  const bundled = JSON.parse(body.secretValue) as Record<string, unknown>;
  assert.equal("orbWebhookSecret" in bundled, false);
});

test("injectTenantSecrets: throws when the request has no database connection details attached", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ enrollId: "x", secret: "y" }));

  await assert.rejects(
    injectTenantSecrets(config(fetchImpl), { tenant: { name: "acme" }, product: "orb" }),
    /no database connection details/,
  );
  assert.equal(calls.length, 0);
});

test("injectTenantSecrets: surfaces a broker-side error (e.g. no encryption key configured) as a thrown error", async () => {
  const { fetchImpl } = fakeFetch(() => Response.json({ error: "encryption_unavailable" }, { status: 503 }));

  await assert.rejects(injectTenantSecrets(config(fetchImpl), REQUEST), /Main app API POST \/v1\/internal\/orb\/enrollments failed \(503\)/);
});

test("revokeTenantSecrets: no-ops without ever calling the broker when the request has no secretRef", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ revoked: true }));

  await revokeTenantSecrets(config(fetchImpl), { tenant: { name: "acme" }, product: "orb" });

  assert.equal(calls.length, 0);
});

test("revokeTenantSecrets: calls the revoke route for the given secretRef", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ revoked: true }));

  await revokeTenantSecrets(config(fetchImpl), { tenant: { name: "acme" }, product: "orb", secretRef: "orbenr_abc" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.loopover.test/v1/internal/orb/enrollments/orbenr_abc/revoke");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer internal-test-token");
});

test("revokeTenantSecrets: tolerates an empty-body success response (e.g. a real 204 No Content)", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));

  await revokeTenantSecrets(config(fetchImpl), { tenant: { name: "acme" }, product: "orb", secretRef: "orbenr_abc" });
});

test("revokeTenantSecrets: a broker-side error (e.g. unknown enrollment) surfaces as a thrown error, not a silent success", async () => {
  const { fetchImpl } = fakeFetch(() => Response.json({ error: "enrollment_not_found" }, { status: 404 }));

  await assert.rejects(
    revokeTenantSecrets(config(fetchImpl), { tenant: { name: "acme" }, product: "orb", secretRef: "orbenr_bogus" }),
    /Main app API POST \/v1\/internal\/orb\/enrollments\/orbenr_bogus\/revoke failed \(404\)/,
  );
});

test("createSecretDriver: bundles injectTenantSecrets/revokeTenantSecrets closed over one config", async () => {
  const { fetchImpl, calls } = fakeFetch((url) => (url.endsWith("/revoke") ? Response.json({ revoked: true }) : Response.json({ enrollId: "orbenr_abc", secret: "orbsec_xyz" })));
  const driver = createSecretDriver(config(fetchImpl));

  const injected = await driver.injectSecrets(REQUEST);
  assert.deepEqual(injected, { secretRef: "orbenr_abc", bootstrapSecret: "orbsec_xyz" });

  await driver.revokeSecrets({ ...REQUEST, secretRef: injected.secretRef });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.url.endsWith("/v1/internal/orb/enrollments/orbenr_abc/revoke"));
});
