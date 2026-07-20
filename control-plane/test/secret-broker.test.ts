import assert from "node:assert/strict";
import { test } from "node:test";

import { createFakeTenantSecretBroker } from "../dist/fake-secret-broker.js";
import { TENANT_SECRET_TYPE_DB_CREDENTIAL } from "../dist/secret-broker.js";

test("fake broker issue + revoke lifecycle", async () => {
  const broker = createFakeTenantSecretBroker({ idPrefix: "t" });
  const issued = await broker.issueEnrollment({
    tenantId: "a",
    product: "orb",
    secretType: TENANT_SECRET_TYPE_DB_CREDENTIAL,
  });
  assert.equal(issued.secretShownOnce, true);
  assert.equal(await broker.revokeEnrollment(issued.enrollId), "revoked");
  assert.equal(await broker.revokeEnrollment(issued.enrollId), "not_found");
  assert.equal(await broker.revokeEnrollment("missing"), "not_found");
  broker.reset();
  assert.equal(broker.enrollments.size, 0);
});
