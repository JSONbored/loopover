export const CONTROL_PLANE_FLAG: string;
export const CONTROL_PLANE_URL_FLAG: string;
export const CONTROL_PLANE_ADMIN_TOKEN_FLAG: string;

export type TenantClientOptions = {
  env?: Record<string, string | undefined>;
  /** Always called as `fetchImpl(url, init)` with a plain string URL -- narrower than `typeof fetch` on
   *  purpose, since that's the only shape this module ever actually calls it with. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
};

export type CreateTenantOptions = TenantClientOptions & {
  product?: string;
};

/** A tenant record as reported by the control plane. Lifecycle `state` is passed through verbatim (the API owns
 *  the vocabulary, e.g. `provisioning` / `active` / `suspended` / `torn down`); other fields vary by product. */
export type TenantRecord = Record<string, unknown>;

export function isControlPlaneEnabled(env?: Record<string, string | undefined>): boolean;

export function createTenant(name: string, options?: CreateTenantOptions): Promise<TenantRecord>;

export function listTenants(options?: TenantClientOptions): Promise<TenantRecord[]>;

export function destroyTenant(name: string, options?: TenantClientOptions): Promise<TenantRecord>;
