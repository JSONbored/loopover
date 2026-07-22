// Real `provisionDatabase`/`dropDatabase` implementation against Neon (#7653, part of #7180's provisioning
// core -- the Postgres provider itself, Neon + Cloudflare Hyperdrive, was already decided on #7180, the same
// decision #7649/#7858 build on for APR's own per-attempt branch forking). Isolation model: ONE tenant = ONE
// Neon branch off the project's default branch, each with its own dedicated database + role -- mirrors
// #7858's own per-attempt branch-off-a-branch design, just one level up (tenant branch, not attempt branch).
//
// Deliberately does NOT implement the full `TenantProvisioningDriver` interface -- only the database methods
// (see `DatabaseDriver` below). Container creation (#7851) and secret injection (#7852) are separate,
// independently-blocked pieces; `withRealDatabaseDriver` (driver-factory.ts) composes this onto an otherwise
// fake driver so `provisionTenant`/`deprovisionTenant`'s orchestration is untouched.
//
// Does NOT create a Cloudflare Hyperdrive binding for the returned connection: `control-plane/` has no
// deployable service or `wrangler.jsonc` yet (#7654, still open) -- there is nowhere for a binding to attach
// to. This returns the raw Neon connection details; routing them through Hyperdrive is #7654's job once a
// real hosted control-plane service exists to declare that binding.
//
// Endpoint paths/response shapes below follow Neon's public v2 API (https://api-docs.neon.tech/reference) as
// documented at the time this was written -- verify against a live account before the first real deploy (the
// test suite mocks every call; no live Neon credentials are used anywhere in this repo).
import { createHash } from "node:crypto";
import type { DatabaseConnectionDetails, TenantProvisioningRequest } from "./tenant-provisioning-driver.js";

const DEFAULT_API_BASE_URL = "https://console.neon.tech/api/v2";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_POLL_INTERVAL_MS = 500;
const DEFAULT_OPERATION_POLL_TIMEOUT_MS = 30_000;

export type NeonDatabaseDriverConfig = {
  apiKey: string;
  projectId: string;
  /** Override for tests only -- production always uses Neon's real API. */
  apiBaseUrl?: string;
  /** Override for tests only -- keeps operation-polling tests fast. */
  operationPollIntervalMs?: number;
  operationPollTimeoutMs?: number;
};

/** The database-only slice of `TenantProvisioningDriver` this module actually implements. Composed onto a full
 *  driver by `withRealDatabaseDriver` (driver-factory.ts), never used standalone against `provisionTenant`. */
export type DatabaseDriver = {
  provisionDatabase(request: TenantProvisioningRequest): Promise<DatabaseConnectionDetails>;
  dropDatabase(request: TenantProvisioningRequest): Promise<void>;
};

type NeonOperation = { id: string; status: string };

type NeonBranch = { id: string; name: string };

type NeonEndpoint = { host: string };

type NeonRole = { name: string; password?: string };

// #8026: the unconditional .slice(0, 63) below used to have no collision guard -- two distinct tenant names
// sharing the same first ~54 characters (after the "tenant-<product>-" prefix and sanitization) would
// truncate to the IDENTICAL Neon branch name. findBranchByName would then find the OTHER tenant's already-
// existing branch and hand back its connection/role/password to the new tenant -- a cross-tenant data-
// isolation bug. Only names that actually need truncating get the suffix, so a short tenant name's branch
// name is completely unchanged (this repo has never deployed against a live Neon project yet -- see this
// file's own header comment -- so there is no pre-existing long-name branch a suffix could orphan).
const NEON_BRANCH_NAME_MAX_LENGTH = 63;
const NEON_BRANCH_NAME_COLLISION_SUFFIX_LENGTH = 8;

/** Neon branch names are case-sensitive but this keeps them predictable and collision-free across products
 *  sharing a tenant name, and safely truncated well under Neon's own length limit. A name that would
 *  otherwise be truncated gets a short hash-of-the-untruncated-name suffix instead, so two long,
 *  prefix-similar tenant names can never collide on the same truncated branch name (#8026). */
function branchNameFor(request: TenantProvisioningRequest): string {
  const raw = `tenant-${request.product}-${request.tenant.name}`.toLowerCase();
  const sanitized = raw.replaceAll(/[^a-z0-9_-]+/g, "-").replaceAll(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (sanitized.length <= NEON_BRANCH_NAME_MAX_LENGTH) return sanitized;
  const suffix = createHash("sha256").update(sanitized).digest("hex").slice(0, NEON_BRANCH_NAME_COLLISION_SUFFIX_LENGTH);
  const prefixLength = NEON_BRANCH_NAME_MAX_LENGTH - 1 - suffix.length;
  return `${sanitized.slice(0, prefixLength)}-${suffix}`;
}

/** A tenant-scoped role gets the SAME derived name as its branch -- one branch, one role, one database, no
 *  separate naming scheme to keep in sync. */
function roleNameFor(request: TenantProvisioningRequest): string {
  return branchNameFor(request);
}

function databaseNameFor(request: TenantProvisioningRequest): string {
  return branchNameFor(request);
}

class NeonApiError extends Error {
  constructor(method: string, path: string, status: number, body: string) {
    super(`Neon API ${method} ${path} failed (${status}): ${body.slice(0, 500)}`);
    this.name = "NeonApiError";
  }
}

async function neonFetch<T>(config: NeonDatabaseDriverConfig, method: string, path: string, body?: unknown): Promise<T> {
  const baseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new NeonApiError(method, path, response.status, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Neon branch/database/role/endpoint mutations are asynchronous -- the mutating call returns pending
 *  `operations[]`, which must reach `"finished"` before the resource is actually usable (e.g. an endpoint
 *  accepting connections). Fails loudly on a `"failed"` operation or on exceeding the poll timeout, rather than
 *  silently returning a not-actually-ready result. */
async function waitForOperations(config: NeonDatabaseDriverConfig, operations: readonly NeonOperation[]): Promise<void> {
  const intervalMs = config.operationPollIntervalMs ?? DEFAULT_OPERATION_POLL_INTERVAL_MS;
  const timeoutMs = config.operationPollTimeoutMs ?? DEFAULT_OPERATION_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let pending = operations.filter((operation) => operation.status !== "finished");
  while (pending.length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`Neon operation(s) did not finish within ${timeoutMs}ms: ${pending.map((operation) => operation.id).join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const refreshed = await Promise.all(
      pending.map((operation) => neonFetch<{ operation: NeonOperation }>(config, "GET", `/projects/${config.projectId}/operations/${operation.id}`)),
    );
    for (const { operation } of refreshed) {
      if (operation.status === "failed") throw new Error(`Neon operation ${operation.id} failed`);
    }
    pending = refreshed.map(({ operation }) => operation).filter((operation) => operation.status !== "finished");
  }
}

async function findBranchByName(config: NeonDatabaseDriverConfig, name: string): Promise<NeonBranch | undefined> {
  const { branches } = await neonFetch<{ branches: NeonBranch[] }>(config, "GET", `/projects/${config.projectId}/branches`);
  return branches.find((branch) => branch.name === name);
}

async function branchEndpointHost(config: NeonDatabaseDriverConfig, branchId: string): Promise<string> {
  const { endpoints } = await neonFetch<{ endpoints: NeonEndpoint[] }>(config, "GET", `/projects/${config.projectId}/branches/${branchId}/endpoints`);
  const endpoint = endpoints[0];
  if (!endpoint) throw new Error(`Neon branch ${branchId} has no compute endpoint`);
  return endpoint.host;
}

function connectionDetailsFor(host: string, database: string, user: string, password: string): DatabaseConnectionDetails {
  const port = 5432;
  return { host, port, database, user, password, connectionString: `postgres://${user}:${password}@${host}:${port}/${database}` };
}

/** Provision (or, idempotently, re-resolve) a tenant's dedicated Neon branch + database + role, returning
 *  connection details routed at that branch's own compute endpoint. Safe to call repeatedly for the same
 *  tenant: an existing branch is found by its stable derived name and its role's password re-revealed (Neon
 *  can reveal a role's current password at any time, not just at creation), rather than creating a duplicate. */
export async function provisionNeonDatabase(config: NeonDatabaseDriverConfig, request: TenantProvisioningRequest): Promise<DatabaseConnectionDetails> {
  const branchName = branchNameFor(request);
  const roleName = roleNameFor(request);
  const databaseName = databaseNameFor(request);

  const existing = await findBranchByName(config, branchName);
  if (existing) {
    const host = await branchEndpointHost(config, existing.id);
    const { role } = await neonFetch<{ role: NeonRole }>(config, "GET", `/projects/${config.projectId}/branches/${existing.id}/roles/${roleName}/reveal_password`);
    if (!role.password) throw new Error(`Neon role ${roleName} on branch ${existing.id} has no revealable password`);
    return connectionDetailsFor(host, databaseName, roleName, role.password);
  }

  const created = await neonFetch<{ branch: NeonBranch; endpoints: NeonEndpoint[]; operations: NeonOperation[] }>(
    config,
    "POST",
    `/projects/${config.projectId}/branches`,
    { branch: { name: branchName }, endpoints: [{ type: "read_write" }] },
  );
  await waitForOperations(config, created.operations);
  const host = created.endpoints[0]?.host;
  if (!host) throw new Error(`Neon branch ${created.branch.id} was created without a compute endpoint`);

  const roleCreated = await neonFetch<{ role: NeonRole; operations: NeonOperation[] }>(
    config,
    "POST",
    `/projects/${config.projectId}/branches/${created.branch.id}/roles`,
    { role: { name: roleName } },
  );
  await waitForOperations(config, roleCreated.operations);
  if (!roleCreated.role.password) throw new Error(`Neon role ${roleName} was created without a password`);

  const databaseCreated = await neonFetch<{ operations: NeonOperation[] }>(
    config,
    "POST",
    `/projects/${config.projectId}/branches/${created.branch.id}/databases`,
    { database: { name: databaseName, owner_name: roleName } },
  );
  await waitForOperations(config, databaseCreated.operations);

  return connectionDetailsFor(host, databaseName, roleName, roleCreated.role.password);
}

/** Idempotent teardown: deleting a tenant's branch cascades to its database/role/endpoint together (Neon
 *  deletes everything scoped to a branch when the branch itself is deleted). A tenant with no branch (never
 *  provisioned, or already dropped) is a safe no-op, matching every other driver's teardown contract. */
export async function dropNeonDatabase(config: NeonDatabaseDriverConfig, request: TenantProvisioningRequest): Promise<void> {
  const branchName = branchNameFor(request);
  const existing = await findBranchByName(config, branchName);
  if (!existing) return;

  // Tolerates a body-less success response (e.g. 204 No Content) -- some APIs return nothing for a DELETE that
  // completed synchronously, with no operation left to poll.
  const result = await neonFetch<{ operations?: NeonOperation[] } | undefined>(config, "DELETE", `/projects/${config.projectId}/branches/${existing.id}`);
  await waitForOperations(config, result?.operations ?? []);
}

/** Bundles {@link provisionNeonDatabase}/{@link dropNeonDatabase} as a {@link DatabaseDriver} closed over one
 *  config -- the shape `withRealDatabaseDriver` composes onto a full `TenantProvisioningDriver`. */
export function createNeonDatabaseDriver(config: NeonDatabaseDriverConfig): DatabaseDriver {
  return {
    provisionDatabase: (request) => provisionNeonDatabase(config, request),
    dropDatabase: (request) => dropNeonDatabase(config, request),
  };
}
