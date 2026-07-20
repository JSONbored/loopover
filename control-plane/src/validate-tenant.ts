// Tenant ref validation shared by provision / deprovision (#7524).

import { ControlPlaneError } from "./errors.js";
import type { TenantRef } from "./types.js";

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const PRODUCT_RE = /^[a-z][a-z0-9_-]{0,31}$/i;

export function assertValidTenantRef(tenant: TenantRef): TenantRef {
  const tenantId = String(tenant.tenantId ?? "").trim();
  const product = String(tenant.product ?? "").trim().toLowerCase();
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    throw new ControlPlaneError("invalid_tenant", `Invalid tenantId: ${JSON.stringify(tenant.tenantId)}`);
  }
  if (!product || !PRODUCT_RE.test(product)) {
    throw new ControlPlaneError("invalid_product", `Invalid product: ${JSON.stringify(tenant.product)}`);
  }
  return { tenantId, product };
}
