// Cron-triggered wake orchestration for hosted AMS tenants (#7182, the control-plane half -- the miner-side
// hosted entry point it wakes, packages/loopover-miner/bin/loopover-miner-hosted.ts, is a separate, already-
// shipped PR). Cloudflare Cron Triggers fire ONE global `scheduled()` handler on a fixed schedule (no
// per-resource cron primitive exists) -- so per-tenant cadence lives as DATA on each AMS tenant's own
// `amsSchedule` (tenant-registry.ts), and this module's job every tick is: find whichever tenants are
// currently due, wake each one's container with the right one-shot command, wait for it to finish, and
// record what happened (#7182's own "0=success/2=failure" exit-code alerting contract, unmodified).
//
// Endpoint/state semantics below follow @cloudflare/containers' documented Container API (start/getState) at
// the time this was written -- verify against a live account before the first real deploy (mirrors
// neon-database-driver.ts's identical header-comment caveat); every test here mocks this boundary.
import type { Product } from "./tenant-provisioning-driver.js";
import type { TenantRegistry, TenantRegistryRecord } from "./tenant-registry.js";

/** The slice of a real Container DO's RPC surface this module actually calls -- a SEPARATE small local
 *  interface from container-driver.ts's own `ContainerStubLike` (that one never needs `getState()`; this one
 *  needs nothing else). Mirrors this package's established "local interface, no SDK import" convention. */
export type WakeStubLike = {
  start(options?: { entrypoint?: string[] }): Promise<void>;
  getState(): Promise<{ status: string; exitCode?: number }>;
};

export type WakeNamespaceLike = {
  getByName(name: string): WakeStubLike;
};

export type AmsWakeConfig = {
  binding: WakeNamespaceLike;
  registry: TenantRegistry;
  /** Overridable for tests only -- production always uses real wall-clock time and real delays. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  now?: () => Date;
};

export type AmsWakeResult = {
  tenant: TenantRegistryRecord["tenant"];
  ranAt: string;
  /** The hosted entry point's own exit code, or `undefined` if the container never reached a stopped state
   *  before `pollTimeoutMs` elapsed (a real failure mode in its own right -- surfaced as `timedOut`, not
   *  silently coerced into a fake exit code). */
  exitCode: number | undefined;
  timedOut: boolean;
};

const HOSTED_ENTRY_BIN = "loopover-miner-hosted";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
// A generous ceiling for a real discover/manage-poll/attempt cycle -- long enough that a real, working run
// almost never hits it, short enough that a genuinely hung container doesn't block this tick's remaining
// tenants indefinitely (this loop processes due tenants one at a time, not in parallel; see wakeDueAmsTenants).
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** Same `${product}:${name}` composite container-driver.ts's own `instanceNameFor` derives -- duplicated
 *  (not imported) because container-driver.ts's version takes a `TenantProvisioningRequest`, a shape this
 *  module has no reason to construct just to call it. */
function instanceNameFor(name: string, product: Product): string {
  return `${product}:${name}`;
}

/** A tenant is due when it's an active AMS tenant with a schedule whose `nextDueAt` has arrived. Anything
 *  else (a different product, a torn-down/provisioning tenant, no schedule at all, or a schedule that isn't
 *  due yet) is silently skipped -- this is a routine filter, not an error condition. */
function isDue(record: TenantRegistryRecord, now: Date): boolean {
  return record.product === "ams" && record.state === "active" && record.amsSchedule !== undefined && new Date(record.amsSchedule.nextDueAt).getTime() <= now.getTime();
}

/** Polls `getState()` until the container reaches a stopped state (with or without an exit code -- either
 *  means the one-shot process is done running) or `timeoutMs` elapses, whichever comes first. Returns
 *  `timedOut: true` only when the deadline was actually hit -- a genuinely-finished container reporting no
 *  exit code (a bare `"stopped"` status) is a different, non-timeout outcome, even though both cases leave
 *  `exitCode` as `undefined`. */
async function pollForExitCode(stub: WakeStubLike, pollIntervalMs: number, timeoutMs: number): Promise<{ exitCode: number | undefined; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await stub.getState();
    if (state.status === "stopped" || state.status === "stopped_with_code") return { exitCode: state.exitCode, timedOut: false };
    if (Date.now() >= deadline) return { exitCode: undefined, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** Wakes every currently-due AMS tenant, one at a time (deliberately sequential, not `Promise.all` -- a
 *  single Cloudflare Cron Trigger invocation has a bounded wall-clock budget shared across every tenant this
 *  tick processes; running them concurrently would trade a slow tick for cross-tenant resource contention on
 *  shared infra this module has no visibility into). Advances each woken tenant's `nextDueAt` from the tick's
 *  OWN start time (not the run's completion time) so schedule drift doesn't accumulate when a cycle runs long.
 */
export async function wakeDueAmsTenants(config: AmsWakeConfig): Promise<AmsWakeResult[]> {
  const now = config.now ?? (() => new Date());
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const tickStartedAt = now();

  const records = await config.registry.list();
  const results: AmsWakeResult[] = [];

  for (const record of records) {
    if (!isDue(record, tickStartedAt)) continue;
    const schedule = record.amsSchedule!;

    const stub = config.binding.getByName(instanceNameFor(record.tenant.name, record.product));
    await stub.start({ entrypoint: [HOSTED_ENTRY_BIN, schedule.command, ...schedule.args] });
    const { exitCode, timedOut } = await pollForExitCode(stub, pollIntervalMs, pollTimeoutMs);

    const ranAt = now().toISOString();
    await config.registry.upsert({
      ...record,
      amsSchedule: {
        ...schedule,
        lastRunAt: ranAt,
        lastExitCode: exitCode,
        nextDueAt: new Date(tickStartedAt.getTime() + schedule.intervalMs).toISOString(),
      },
      updatedAt: ranAt,
    });
    results.push({ tenant: record.tenant, ranAt, exitCode, timedOut });
  }

  return results;
}
