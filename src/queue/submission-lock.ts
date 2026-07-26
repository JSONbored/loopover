import { DurableObject } from "cloudflare:workers";

// Per-key exclusive mutex Durable Object (#8896). One instance per lock key (`idFromName(key)`), used by
// `claimTransientLock` when `env.SUBMISSION_LOCK` is bound. Replaces the cache-only "interim" mutex for hosted
// Workers while self-host (no DO binding) keeps the Redis/transient-cache path unchanged.

const STORAGE_KEY = "lock";

type LockRecord = {
  ownerToken: string;
  expiresAt: number;
};

type ClaimBody = {
  ownerToken?: unknown;
  ttlSeconds?: unknown;
  // #9008: a forced re-run intentionally takes ownership even from a still-live holder — mirrors the
  // cache-path steal in claimTransientLock (transient-locks.ts), kept consistent across both lock backends.
  steal?: unknown;
};

type ReleaseBody = {
  ownerToken?: unknown;
};

/**
 * Strongly-consistent per-key lock. Concurrent claims against the same DO id serialize at the platform input
 * gate; only the first unexpired claim succeeds until release or TTL.
 */
export class SubmissionLock extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.replace(/^\/+/, "") || "claim";
    if (action === "claim") return this.handleClaim(request);
    if (action === "release") return this.handleRelease(request);
    return Response.json({ error: "unknown_action" }, { status: 404 });
  }

  private async handleClaim(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as ClaimBody | null;
    const ownerToken = typeof body?.ownerToken === "string" ? body.ownerToken : "";
    const ttlSeconds = typeof body?.ttlSeconds === "number" ? body.ttlSeconds : NaN;
    if (!ownerToken || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return Response.json({ error: "invalid_claim" }, { status: 400 });
    }

    const steal = body?.steal === true;
    const now = Date.now();
    const existing = await this.ctx.storage.get<LockRecord>(STORAGE_KEY);
    if (!steal && existing && existing.expiresAt > now && existing.ownerToken !== ownerToken) {
      return Response.json({ acquired: false });
    }

    await this.ctx.storage.put(STORAGE_KEY, {
      ownerToken,
      expiresAt: now + ttlSeconds * 1000,
    } satisfies LockRecord);
    return Response.json({ acquired: true });
  }

  private async handleRelease(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as ReleaseBody | null;
    const ownerToken = typeof body?.ownerToken === "string" ? body.ownerToken : "";
    if (!ownerToken) return Response.json({ error: "invalid_release" }, { status: 400 });

    const existing = await this.ctx.storage.get<LockRecord>(STORAGE_KEY);
    if (!existing || existing.ownerToken !== ownerToken) {
      return Response.json({ released: false });
    }
    await this.ctx.storage.delete(STORAGE_KEY);
    return Response.json({ released: true });
  }
}
