// Neon branch-per-attempt disposable DB fork for APR execution (#7858, implements #7649's ratified decision).
// Mirrors worktree-pool.ts's per-attempt code-checkout isolation one level deeper: where that module gives
// each attempt its own git worktree (a filesystem-level fork), this module gives an attempt its own Neon
// branch (a storage-level fork) off the OPERATOR's already-provisioned tenant branch -- never off Neon's
// project-level default branch, and never shared between concurrent attempts.
//
// Self-host scope only (see this issue's own scope note): a bare containerized Node.js process connects to a
// Neon branch over the plain Postgres wire protocol via `connectionString` below -- no Cloudflare Hyperdrive
// binding is used or required. Hyperdrive is an optional, Workers-runtime-specific connection-pooling layer;
// Neon branches are independently connectable with any standard Postgres client regardless of whether one
// exists. The hosted path (control-plane's AmsTenantContainer) has its own separate, still-open blocker before
// ANY database credential can reach a running hosted container at all (#8202) -- unrelated to this module.
//
// Endpoint paths/response shapes below mirror control-plane/src/neon-database-driver.ts's already-reviewed
// pattern (Neon's public v2 API, https://api-docs.neon.tech/reference, as documented at the time this was
// written) -- same caveat that file states applies here too: verify against a live account before the first
// real deploy; the test suite mocks every call, no live Neon credentials are used anywhere in this repo.
import { createHash } from "node:crypto";

const DEFAULT_API_BASE_URL = "https://console.neon.tech/api/v2";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_POLL_INTERVAL_MS = 500;
const DEFAULT_OPERATION_POLL_TIMEOUT_MS = 30_000;

export type AttemptDbForkConfig = {
  apiKey: string;
  projectId: string;
  /** The operator's own already-provisioned Neon branch ID to fork attempt branches FROM -- never Neon's
   *  project-level default branch, so an attempt fork always starts from the operator's real, current tenant
   *  data, not an unrelated/empty baseline. */
  parentBranchId: string;
  /** Override for tests only -- production always uses Neon's real API. */
  apiBaseUrl?: string;
  /** Override for tests only -- keeps operation-polling tests fast. */
  operationPollIntervalMs?: number;
  operationPollTimeoutMs?: number;
};

export type AttemptDbFork = {
  branchId: string;
  connectionString: string;
};

type NeonOperation = { id: string; status: string };
type NeonBranch = { id: string; name: string };
type NeonEndpoint = { host: string };
type NeonRole = { name: string; password?: string };

// Neon branch names are case-sensitive and length-limited (63 chars) -- mirrors neon-database-driver.ts's own
// #8026 collision-guard reasoning: only truncate names that actually need it, and suffix a truncated one with
// a short hash of the untruncated name so two long, prefix-similar attempt ids can never collide on the same
// branch name.
const NEON_BRANCH_NAME_MAX_LENGTH = 63;
const NEON_BRANCH_NAME_COLLISION_SUFFIX_LENGTH = 8;

function sanitizeForBranchName(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function branchNameFor(attemptId: string): string {
  const sanitized = sanitizeForBranchName(`attempt-${attemptId}`);
  if (sanitized.length <= NEON_BRANCH_NAME_MAX_LENGTH) return sanitized;
  const suffix = createHash("sha256").update(sanitized).digest("hex").slice(0, NEON_BRANCH_NAME_COLLISION_SUFFIX_LENGTH);
  const prefixLength = NEON_BRANCH_NAME_MAX_LENGTH - 1 - suffix.length;
  return `${sanitized.slice(0, prefixLength)}-${suffix}`;
}

/** Every attempt branch's role is named identically to its branch -- one branch, one role, no separate naming
 *  scheme to keep in sync (same convention as neon-database-driver.ts's tenant-level roleNameFor). */
function roleNameForBranch(branchName: string): string {
  return branchName;
}

class NeonApiError extends Error {
  constructor(method: string, path: string, status: number, body: string) {
    super(`Neon API ${method} ${path} failed (${status}): ${body.slice(0, 500)}`);
    this.name = "NeonApiError";
  }
}

async function neonFetch<T>(config: AttemptDbForkConfig, method: string, path: string, body?: unknown): Promise<T> {
  const baseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new NeonApiError(method, path, response.status, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Same async-operation-polling contract as neon-database-driver.ts's identical helper: branch/role mutations
 *  return pending `operations[]` that must reach `"finished"` before the resource is actually usable. */
async function waitForOperations(config: AttemptDbForkConfig, operations: readonly NeonOperation[]): Promise<void> {
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

async function findBranchByName(config: AttemptDbForkConfig, name: string): Promise<NeonBranch | undefined> {
  const { branches } = await neonFetch<{ branches: NeonBranch[] }>(config, "GET", `/projects/${config.projectId}/branches`);
  return branches.find((branch) => branch.name === name);
}

/** Create a disposable Neon branch forked off `config.parentBranchId` for exactly one attempt, with its own
 *  freshly-created role (explicit, not assumed-inherited from the parent -- this repo has no live Neon account
 *  to verify role-inheritance semantics against, so this mirrors neon-database-driver.ts's own always-explicit
 *  role-creation pattern rather than relying on unverified copy-on-write assumptions). The database itself
 *  (and its data) IS inherited from the parent branch via Neon's storage-level branching -- unlike a role,
 *  Postgres databases are catalog objects that live inside the branched storage itself, so no separate
 *  database-creation call is made here.
 *
 *  Idempotent on `attemptId`: a retried call for the same attempt finds its already-created branch by name
 *  (via {@link findBranchByName}) instead of creating a duplicate, mirroring provisionNeonDatabase's own
 *  existing-branch-reuse path. The attempt's own database name is resolved from the PARENT branch's own
 *  database list (the branch inherits the same database(s) the parent already has), not re-derived from
 *  attemptId, since it must match whatever database the coding agent's own connection actually expects. */
export async function createAttemptDbFork(config: AttemptDbForkConfig, attemptId: string): Promise<AttemptDbFork> {
  const branchName = branchNameFor(attemptId);
  const roleName = roleNameForBranch(branchName);

  const existing = await findBranchByName(config, branchName);
  if (existing) {
    const { endpoints } = await neonFetch<{ endpoints: NeonEndpoint[] }>(config, "GET", `/projects/${config.projectId}/branches/${existing.id}/endpoints`);
    const host = endpoints[0]?.host;
    if (!host) throw new Error(`Neon attempt branch ${existing.id} has no compute endpoint`);
    const { role } = await neonFetch<{ role: NeonRole }>(config, "GET", `/projects/${config.projectId}/branches/${existing.id}/roles/${roleName}/reveal_password`);
    if (!role.password) throw new Error(`Neon role ${roleName} on attempt branch ${existing.id} has no revealable password`);
    const databaseName = await parentDatabaseName(config);
    return { branchId: existing.id, connectionString: connectionStringFor(host, databaseName, roleName, role.password) };
  }

  const databaseName = await parentDatabaseName(config);
  const created = await neonFetch<{ branch: NeonBranch; endpoints: NeonEndpoint[]; operations: NeonOperation[] }>(
    config,
    "POST",
    `/projects/${config.projectId}/branches`,
    { branch: { name: branchName, parent_id: config.parentBranchId }, endpoints: [{ type: "read_write" }] },
  );
  await waitForOperations(config, created.operations);
  const host = created.endpoints[0]?.host;
  if (!host) throw new Error(`Neon attempt branch ${created.branch.id} was created without a compute endpoint`);

  const roleCreated = await neonFetch<{ role: NeonRole; operations: NeonOperation[] }>(
    config,
    "POST",
    `/projects/${config.projectId}/branches/${created.branch.id}/roles`,
    { role: { name: roleName } },
  );
  await waitForOperations(config, roleCreated.operations);
  if (!roleCreated.role.password) throw new Error(`Neon role ${roleName} was created without a password`);

  return { branchId: created.branch.id, connectionString: connectionStringFor(host, databaseName, roleName, roleCreated.role.password) };
}

async function parentDatabaseName(config: AttemptDbForkConfig): Promise<string> {
  const { databases } = await neonFetch<{ databases: { name: string }[] }>(
    config,
    "GET",
    `/projects/${config.projectId}/branches/${config.parentBranchId}/databases`,
  );
  const database = databases[0];
  if (!database) throw new Error(`Neon parent branch ${config.parentBranchId} has no database to fork`);
  return database.name;
}

function connectionStringFor(host: string, database: string, user: string, password: string): string {
  return `postgres://${user}:${password}@${host}:5432/${database}`;
}

/** Discard an attempt's disposable branch. Idempotent: an attempt whose branch was never created (blocked
 *  before {@link createAttemptDbFork} ran) or already discarded is a safe no-op. Deleting a Neon branch
 *  cascades to its role/database/endpoint together -- there is nothing else to clean up separately. Never
 *  merges the branch's data back into the parent; ratified explicitly by #7649 as a hard requirement, not a
 *  default that happens to be convenient here. */
export async function discardAttemptDbFork(config: AttemptDbForkConfig, attemptId: string): Promise<void> {
  const branchName = branchNameFor(attemptId);
  const existing = await findBranchByName(config, branchName);
  if (!existing) return;

  // Tolerates a body-less success response (e.g. 204 No Content) -- some APIs return nothing for a DELETE that
  // completed synchronously, with no operation left to poll.
  const result = await neonFetch<{ operations?: NeonOperation[] } | undefined>(config, "DELETE", `/projects/${config.projectId}/branches/${existing.id}`);
  await waitForOperations(config, result?.operations ?? []);
}
