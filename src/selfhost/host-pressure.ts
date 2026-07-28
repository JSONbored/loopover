// Optional host-CPU-pressure hint for maintenance-job admission (see maintenance-admission.ts). Node-only --
// `node:os`'s loadavg() has no meaningful signal on Cloudflare Workers -- this module is imported ONLY by the
// self-host Node queue backends (sqlite-queue.ts / pg-queue.ts), never by src/index.ts's Worker bundle, so a
// static `node:os` import here is safe (mirrors the existing `hostname` import in selfhost/posthog.ts).
import { cpus, freemem, loadavg, totalmem } from "node:os";

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

/**
 * #9487: the fraction of host memory currently IN USE (0..1), or `null` when unavailable.
 *
 * Host pressure watched CPU only, but on the deployment this was found on (a GPU box running Ollama at
 * ~9.9 GiB alongside browserless at ~1.5 GiB) memory is the realistic killer: nothing observed it, nothing
 * shed load for it, and the OOM killer made the decision instead — which takes the whole container, losing
 * every in-flight job, rather than deferring one maintenance job.
 *
 * Same fail-open contract as {@link hostLoadAvg1PerCore}: any error, or a reading that cannot be a real
 * ratio, yields `null` ("signal unavailable"), never a misleading 0. A caller must treat `null` as "skip this
 * check".
 *
 * HONEST LIMIT, shared with the load signal above: `node:os` reports the HOST's memory, so under a container
 * memory limit (cgroup) this understates pressure — the container can be at its own ceiling while the host
 * looks idle. Reading `/sys/fs/cgroup/memory.current` would fix that and is deliberately not done here: it is
 * Linux- and cgroup-v2-specific, and this module is a best-effort *hint* for admission, not an accounting
 * boundary. The same caveat already applies to loadavg-over-container-cores.
 */
export function hostMemoryUsedFraction(): number | null {
  try {
    const total = totalmem();
    const free = freemem();
    if (!Number.isFinite(total) || total <= 0) return null;
    if (!Number.isFinite(free) || free < 0) return null;
    const used = (total - free) / total;
    // A free reading above total would put this outside 0..1 -- treat any impossible ratio as unavailable
    // rather than clamping, so a broken platform reading can never masquerade as "no pressure".
    if (used < 0 || used > 1) return null;
    return used;
  } catch {
    return null;
  }
}
