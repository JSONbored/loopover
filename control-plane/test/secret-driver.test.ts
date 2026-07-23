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

test("injectTenantSecrets: stores the WHOLE database connection details JSON-encoded, returns enrollId as secretRef and the one-time secret as bootstrapSecret", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ enrollId: "orbenr_abc", secret: "orbsec_xyz" }, { status: 200 }));

  const result = await injectTenantSecrets(config(fetchImpl), REQUEST);

  assert.deepEqual(result, { secretRef: "orbenr_abc", bootstrapSecret: "orbsec_xyz" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.loopover.test/v1/internal/orb/enrollments");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer internal-test-token");
  const body = JSON.parse(calls[0]!.init.body as string) as { secretType: string; secretValue: string };
  assert.equal(body.secretType, "tenant_db_credential");
  assert.deepEqual(JSON.parse(body.secretValue), DATABASE);
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
