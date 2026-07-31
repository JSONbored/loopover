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
  /** Caps how many due tenants ONE tick will wake (#9143, defect 7) -- production always uses
   *  {@link DEFAULT_MAX_TENANTS_PER_TICK}; overridable for tests only. */
  maxTenantsPerTick?: number;
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
  /** `true` when this tenant's wake threw at any point (`start()`, `pollForExitCode`'s `getState()`, or
   *  either `registry.upsert()` call) and was caught so the rest of the tick could keep going. `exitCode` is
   *  always `undefined` and `timedOut` is always `false` on a failed result -- neither one describes a wake
   *  that never got the chance to finish. */
  failed: boolean;
};

const HOSTED_ENTRY_BIN = "loopover-miner-hosted";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
// #9143 (defect 7): wrangler.jsonc's own Cron Trigger fires this module's `scheduled()` caller every 5
// minutes (`*/5 * * * *`). The OLD 10-minute default here GUARANTEED an overlapping tick: nextDueAt used to
// advance only AFTER a woken tenant's poll resolved (see wakeDueAmsTenants's own header comment on the fix),
// so one hung tenant's poll alone could still be running when the NEXT tick fired 5 minutes later -- which
// would then see that SAME tenant's nextDueAt untouched (still overdue) and wake it a SECOND time
// concurrently, with no lock/in-flight marker anywhere to stop it, racing both ticks' upserts against the
// same record. Capped well under the cron interval, AND `wakeDueAmsTenants` now claims each tenant's next
// nextDueAt BEFORE starting its poll (not after) so a genuinely-overlapping tick observes the claim and skips
// it regardless of this timeout's exact value -- but a short timeout is still what keeps a normal, non-
// overlapping tick's wall-clock budget sane across every due tenant it processes sequentially, not just one.
const DEFAULT_POLL_TIMEOUT_MS = 2 * 60 * 1000;
// #9143 (defect 7): bounds how many due tenants ONE tick will wake. Sequential-by-design (see
// wakeDueAmsTenants's own comment on why not Promise.all) means a fleet with more due tenants than this in a
// single 5-minute window would otherwise risk the WHOLE tick running long even when every individual tenant
// behaves within DEFAULT_POLL_TIMEOUT_MS -- deferring the excess to the next tick (their nextDueAt is already
// in the past, so nothing is lost, only delayed) keeps one tick's total wall-clock bounded too.
const DEFAULT_MAX_TENANTS_PER_TICK = 20;

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
 *  shared infra this module has no visibility into), up to {@link DEFAULT_MAX_TENANTS_PER_TICK} (#9143, defect
 *  7) per invocation.
 *
 *  #9143: `nextDueAt` is now advanced BEFORE the poll starts, not after it resolves -- the pre-#9143 order
 *  (advance only once `pollForExitCode` returned) meant a hung/slow tenant's `nextDueAt` stayed in the past
 *  for the ENTIRE poll, so a genuinely-overlapping tick (the 5-minute cron firing again while a >5-minute poll
 *  from the prior tick was still running, or any other concurrent invocation) would see the same tenant still
 *  due and wake it a SECOND time, racing both ticks' upserts against the same record with no lock or in-flight
 *  marker anywhere. Claiming the slot up front means an overlapping tick observes `nextDueAt` already moved
 *  and skips it -- from the tick's OWN start time (not the run's completion time), so schedule drift doesn't
 *  accumulate when a cycle runs long, exactly as before. */
export async function wakeDueAmsTenants(config: AmsWakeConfig): Promise<AmsWakeResult[]> {
  const now = config.now ?? (() => new Date());
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const maxTenantsPerTick = config.maxTenantsPerTick ?? DEFAULT_MAX_TENANTS_PER_TICK;
  const tickStartedAt = now();

  const records = await config.registry.list();
  const results: AmsWakeResult[] = [];
  let woken = 0;

  for (const record of records) {
    if (woken >= maxTenantsPerTick) break;
    if (!isDue(record, tickStartedAt)) continue;
    const schedule = record.amsSchedule!;
    woken += 1;

    // Claim this tenant's next slot BEFORE starting its poll (#9143) -- see this function's own header
    // comment on why.
    const claimedNextDueAt = new Date(tickStartedAt.getTime() + schedule.intervalMs).toISOString();

    // Isolate this one tenant's wake: a rejection from `start()`, from `pollForExitCode`'s `getState()`, or
    // from either `upsert()` below must cost only this tenant its cycle, not the whole tick (#10063) --
    // mirroring http-app.ts's `provisionTenant` failure seam, which likewise records a terminal state before
    // letting its caller move on instead of losing the surrounding request.
    try {
      await config.registry.upsert({
        ...record,
        amsSchedule: { ...schedule, nextDueAt: claimedNextDueAt },
        updatedAt: now().toISOString(),
      });

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
          nextDueAt: claimedNextDueAt,
        },
        updatedAt: ranAt,
      });
      results.push({ tenant: record.tenant, ranAt, exitCode, timedOut, failed: false });
    } catch {
      const ranAt = now().toISOString();
      try {
        // Still attempt the lastRunAt write so the record doesn't silently look like it never ran --
        // whichever upsert above threw (or never ran at all), this is a fresh attempt of its own.
        await config.registry.upsert({
          ...record,
          amsSchedule: { ...schedule, lastRunAt: ranAt, nextDueAt: claimedNextDueAt },
          updatedAt: ranAt,
        });
      } catch {
        // The failure write itself failed too -- nothing left to attempt this tick. The claimed
        // `nextDueAt` (if that first upsert landed) still moved forward, so this tenant is retried next
        // cycle rather than starving the rest of this one.
      }
      results.push({ tenant: record.tenant, ranAt, exitCode: undefined, timedOut: false, failed: true });
    }
  }

  return results;
}
