import assert from "node:assert/strict";
import { test } from "node:test";

import { assertValidTenantRef } from "../dist/validate-tenant.js";
import { ControlPlaneError } from "../dist/errors.js";

test("assertValidTenantRef normalizes product case", () => {
  assert.deepEqual(assertValidTenantRef({ tenantId: "T1", product: "ORB" }), {
    tenantId: "T1",
    product: "orb",
  });
});

test("assertValidTenantRef rejects empty / illegal ids", () => {
  assert.throws(
    () => assertValidTenantRef({ tenantId: "bad id", product: "orb" }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "invalid_tenant",
  );
  assert.throws(
    () => assertValidTenantRef({ tenantId: "ok", product: "" }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "invalid_product",
  );
});
