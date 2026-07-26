// Minimal stand-in for the `cloudflare:workers` module on the Node self-host runtime. Imports of
// `DurableObject` (RateLimiter, SubmissionLock) resolve here. Those DOs are NEVER instantiated on self-host —
// env.RATE_LIMITER / env.SUBMISSION_LOCK are undefined, so callers fall through before any DO is touched —
// so this base class only needs to make the import + `extends DurableObject` resolve. The self-host esbuild
// build aliases `cloudflare:workers` to this file (see the Docker build / build:selfhost script).
export class DurableObject<E = unknown> {
  constructor(
    protected ctx?: unknown,
    protected env?: E,
  ) {}
}
