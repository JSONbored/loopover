// Minimal stand-in for the `cloudflare:workers` module on the Node self-host runtime. The only import of it
// in the codebase is `DurableObject` (auth/rate-limit.ts → the RateLimiter DO). That DO is NEVER instantiated
// on self-host — env.RATE_LIMITER is undefined, so enforceRateLimit returns null before any DO is touched —
// so this base class only needs to make the import + `extends DurableObject` resolve. The self-host esbuild
// build aliases `cloudflare:workers` to this file (see the Docker build / build:selfhost script).
export class DurableObject<E = unknown> {
  constructor(
    protected ctx?: unknown,
    protected env?: E,
  ) {}
}
export class WorkerEntrypoint<E = unknown> {
  constructor(
    protected ctx?: unknown,
    protected env?: E,
  ) {}
}
export class RpcTarget {}
