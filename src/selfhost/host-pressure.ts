// Optional host-CPU-pressure hint for maintenance-job admission (see maintenance-admission.ts). Node-only --
// `node:os`'s loadavg() has no meaningful signal on Cloudflare Workers -- this module is imported ONLY by the
// self-host Node queue backends (sqlite-queue.ts / pg-queue.ts), never by src/index.ts's Worker bundle, so a
// static `node:os` import here is safe (mirrors the existing `hostname` import in selfhost/sentry.ts).
import { cpus, loadavg } from "node:os";

/** The 1-minute load average normalized per logical core, so the SAME threshold means the same thing on a
 *  4-vCPU box as a 32-vCPU box. Best-effort and fail-open: any error, or a reading that can't possibly be a
 *  real load average, yields `null` ("signal unavailable") rather than a misleading 0 -- a caller must treat
 *  `null` as "skip this check", never as "load is zero". (On Windows, Node's loadavg() always returns
 *  `[0, 0, 0]` by design; that legitimately normalizes to 0, which just never trips a pressure threshold.) */
export function hostLoadAvg1PerCore(): number | null {
  try {
    const load1 = loadavg()[0] ?? Number.NaN;
    if (!Number.isFinite(load1) || load1 < 0) return null;
    const coreCount = cpus().length;
    if (!Number.isFinite(coreCount) || coreCount < 1) return null;
    return load1 / coreCount;
  } catch {
    return null;
  }
}
