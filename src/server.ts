// Self-host Node entry (#980). Runs gittensory's SAME Worker handlers on Node. Backends are pluggable:
//   • DB:    SQLite (node:sqlite, default) OR Postgres (DATABASE_URL=postgres://… → shared, multi-instance).
//   • Queue: durable SQLite queue OR a Postgres queue (FOR UPDATE SKIP LOCKED).
//   • Rate limit: a Redis fixed-window limiter when REDIS_URL is set (else no limiting, as today).
//   • RAG vector store: SQLite-only for now (omitted on Postgres → RAG degrades to no-context).
// Serves the Hono app via @hono/node-server, drives the queue with the same processJob, ticks the same
// scheduled handler on a timer, exposes /health /ready /metrics, and shuts down gracefully. The Cloudflare
// Worker (src/index.ts) is untouched — this is a parallel entry the self-host esbuild build bundles.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import worker from "./index";
import { processJob } from "./queue/processors";
import { createSelfHostAi } from "./selfhost/ai";
import { credentialsToEnv, exchangeManifestCode, renderSetupPage } from "./selfhost/setup-wizard";
import { exportOrbBatch } from "./selfhost/orb-collector";
import { createD1Adapter, nodeSqliteDriver } from "./selfhost/d1-adapter";
import { readiness } from "./selfhost/health";
import { gauge, incr, observe, renderMetrics } from "./selfhost/metrics";
import { runSelfHostMigrations } from "./selfhost/migrate";
import { createPgAdapter } from "./selfhost/pg-adapter";
import { createPgQueue } from "./selfhost/pg-queue";
import { createPgVectorize, initPgVectorize } from "./selfhost/pg-vectorize";
import { createSqliteQueue } from "./selfhost/sqlite-queue";
import { createSqliteVectorize } from "./selfhost/vectorize";
import type { JobMessage } from "./types";

/** Resolve `<NAME>_FILE` env vars (Docker secrets / multi-line keys) into `<NAME>` at startup. */
function loadFileSecrets(): void {
  for (const key of Object.keys(process.env)) {
    if (!key.endsWith("_FILE") || !process.env[key]) continue;
    const target = key.slice(0, -"_FILE".length);
    if (process.env[target]) continue; // an explicit value wins
    try {
      process.env[target] = readFileSync(process.env[key] as string, "utf8").trim();
    } catch {
      console.error(JSON.stringify({ level: "error", event: "selfhost_secret_file_unreadable", var: key }));
    }
  }
}

interface Backend {
  db: D1Database;
  queue: { binding: Queue; start(): void; stop(): Promise<void>; size(): number | Promise<number>; deadCount(): number | Promise<number> };
  vectorize?: Vectorize;
  shutdown(): Promise<void>;
}

/** Retry a Postgres connection until it succeeds (up to maxWaitMs). Prevents crash-restart loops when
 *  gittensory starts before Postgres is ready (common in `--profile postgres` compose stacks). */
async function waitForPostgres(url: string, maxWaitMs = 30_000): Promise<void> {
  const pg = (await import("pg")).default;
  const start = Date.now();
  let attempt = 0;
  while (true) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      attempt++;
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) throw new Error(`Postgres not ready after ${maxWaitMs}ms (${attempt} attempts)`);
      const delay = Math.min(2000, 200 * attempt);
      console.log(JSON.stringify({ event: "selfhost_pg_wait", attempt, elapsed_ms: elapsed, retry_in_ms: delay }));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Retry an async readiness operation with backoff until it succeeds (up to maxWaitMs). Prevents a
 *  crash-restart loop when gittensory starts before a dependency (e.g. Qdrant) is accepting connections —
 *  Qdrant's init is a single fetch with no retry, so a slow-starting --profile qdrant container would
 *  otherwise take the whole process down. */
async function retryUntilReady(name: string, op: () => Promise<void>, maxWaitMs = 30_000): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    try {
      await op();
      return;
    } catch (error) {
      attempt++;
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) {
        throw new Error(`${name} not ready after ${maxWaitMs}ms (${attempt} attempts): ${error instanceof Error ? error.message : "unknown error"}`);
      }
      const delay = Math.min(2000, 200 * attempt);
      console.log(JSON.stringify({ event: "selfhost_dependency_wait", dependency: name, attempt, elapsed_ms: elapsed, retry_in_ms: delay }));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Build the Postgres backend (shared DB + queue) when DATABASE_URL is a postgres:// URL. */
async function buildPostgresBackend(url: string, consume: (m: JobMessage) => Promise<void>): Promise<Backend> {
  await waitForPostgres(url);
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10)); // int8 (COUNT) → number, like D1
  const pool = new pg.Pool({ connectionString: url });
  const db = createPgAdapter(pool);
  const queue = createPgQueue(pool, consume);
  await queue.init();
  let vectorize: Vectorize | undefined;
  if (process.env.PGVECTOR_ENABLED === "true") {
    await initPgVectorize(pool);
    vectorize = createPgVectorize(pool);
  }
  return {
    db,
    queue,
    ...(vectorize ? { vectorize } : {}),
    async shutdown() {
      await queue.stop();
      await pool.end();
    },
  };
}

/** Build the SQLite backend (single file, default). */
function buildSqliteBackend(consume: (m: JobMessage) => Promise<void>): Backend {
  const sqlite = new DatabaseSync(process.env.DATABASE_PATH ?? "/data/gittensory.sqlite");
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const driver = nodeSqliteDriver(sqlite as never);
  const db = createD1Adapter(driver);
  const queue = createSqliteQueue(driver, consume);
  const vectorize = createSqliteVectorize(driver);
  return {
    db,
    queue,
    vectorize,
    async shutdown() {
      await queue.stop();
      try {
        sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        sqlite.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

async function main(): Promise<void> {
  loadFileSecrets();
  const startedAt = Date.now();

  // The queue consumer captures `env`, assigned below (the first job only runs once an HTTP/cron event
  // arrives, by which point env is set).
  let env: Env;
  const consume = async (message: JobMessage): Promise<void> => {
    await processJob(env, message);
  };

  const databaseUrl = process.env.DATABASE_URL;
  const usePostgres = !!databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl);
  const backend = usePostgres ? await buildPostgresBackend(databaseUrl as string, consume) : buildSqliteBackend(consume);
  console.log(JSON.stringify({ event: "selfhost_backend", backend: usePostgres ? "postgres" : "sqlite" }));

  const applied = await runSelfHostMigrations(backend.db, process.env.MIGRATIONS_DIR ?? "migrations");
  console.log(JSON.stringify({ event: "selfhost_migrations_applied", count: applied }));

  const ai = createSelfHostAi(process.env);
  if (ai) console.log(JSON.stringify({ event: "selfhost_ai_provider", provider: process.env.AI_PROVIDER }));

  // Redis fixed-window rate limiter + webhook dedup cache (else absent when REDIS_URL is unset).
  let rateLimiter: DurableObjectNamespace | undefined;
  let webhookCache: import("./selfhost/redis-cache").RedisCache | undefined;
  if (process.env.REDIS_URL) {
    const { Redis } = await import("ioredis");
    const redisClient = new Redis(process.env.REDIS_URL);
    const { createRedisRateLimiter } = await import("./selfhost/redis-ratelimit");
    const { createRedisCache } = await import("./selfhost/redis-cache");
    rateLimiter = createRedisRateLimiter(redisClient);
    webhookCache = createRedisCache(redisClient);
    console.log(JSON.stringify({ event: "selfhost_rate_limiter", backend: "redis" }));
  }

  // Qdrant vector store — overrides the backend's built-in sqlite-vec / pgvector when QDRANT_URL is set.
  let vectorizeOverride: Vectorize | undefined;
  if (process.env.QDRANT_URL) {
    const { createQdrantVectorize, initQdrantCollection } = await import("./selfhost/qdrant-vectorize");
    // Retry until Qdrant accepts the collection PUT — the container may still be booting when we start.
    await retryUntilReady("qdrant", () => initQdrantCollection(process.env.QDRANT_URL as string));
    vectorizeOverride = createQdrantVectorize(process.env.QDRANT_URL);
    console.log(JSON.stringify({ event: "selfhost_vectorize", backend: "qdrant" }));
  }

  env = {
    ...process.env,
    DB: backend.db,
    JOBS: backend.queue.binding,
    AI: ai,
    // Qdrant takes priority; falls back to the backend's built-in vectorize (pgvector or sqlite-vec)
    ...(vectorizeOverride ? { VECTORIZE: vectorizeOverride } : backend.vectorize ? { VECTORIZE: backend.vectorize } : {}),
    ...(rateLimiter ? { RATE_LIMITER: rateLimiter } : {}),
    // Visual review: when BROWSER_WS_ENDPOINT is set, expose a truthy BROWSER binding so shot.ts's
    // `if (!env.BROWSER) return` guard is bypassed; the puppeteer stub then connects via WS.
    ...(process.env.BROWSER_WS_ENDPOINT ? { BROWSER: {} } : {}),
  } as unknown as Env;

  gauge("gittensory_queue_pending", () => backend.queue.size());
  gauge("gittensory_queue_dead", () => backend.queue.deadCount());
  gauge("gittensory_uptime_seconds", () => Math.floor((Date.now() - startedAt) / 1000));
  // Pre-initialize job counters to 0 so they appear in the first Prometheus scrape (lazy counters
  // created on first use would otherwise cause "No data" in Grafana until the first job event).
  for (const c of [
    "gittensory_jobs_enqueued_total", "gittensory_jobs_processed_total",
    "gittensory_jobs_failed_total", "gittensory_jobs_dead_total",
    "gittensory_webhook_dedup_total",
    "gittensory_qdrant_queries_total", "gittensory_qdrant_upserts_total",
    "gittensory_orb_events_exported_total", "gittensory_orb_export_errors_total",
  ])
    incr(c, undefined, 0);
  // Seed gittensory_http_requests_total per status class so the breakdown panel has every series from the
  // first scrape (keeping the metric consistently labeled — never mix labeled and unlabeled samples).
  for (const status of ["2xx", "3xx", "4xx", "5xx"]) incr("gittensory_http_requests_total", { status }, 0);

  const ctx = {
    waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => undefined),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const port = Number(process.env.PORT ?? 8787);
  const server = serve(
    {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/health") return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } });
        if (path === "/ready") {
          const r = await readiness(backend.db);
          return new Response(JSON.stringify(r), { status: r.ok ? 200 : 503, headers: { "content-type": "application/json" } });
        }
        if (path === "/metrics") return new Response(await renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } });
        // First-run GitHub App setup wizard — only while no App is configured (can't rebind a live install).
        if ((path === "/setup" || path === "/setup/callback") && !process.env.GITHUB_APP_ID) {
          // PUBLIC_API_ORIGIN is required: falling back to request.url.origin would let an attacker spoof
          // the Host header and redirect the App-creation callback to an attacker-controlled domain, where
          // they could exchange the one-time code for the App private key and webhook secret.
          const origin = process.env.PUBLIC_API_ORIGIN;
          if (!origin) {
            return new Response(
              "PUBLIC_API_ORIGIN must be set before using the setup wizard — add it to your .env file",
              { status: 400 },
            );
          }
          if (path === "/setup") {
            // Generate a per-visit CSRF nonce, embed it in the manifest's redirect_url, and bind it to
            // this browser session via an HttpOnly cookie so the callback can validate it.
            const state = randomUUID();
            return new Response(renderSetupPage(origin, state), {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "Set-Cookie": `setup_state=${state}; Path=/setup; HttpOnly; SameSite=Lax; Max-Age=3600`,
              },
            });
          }
          const params = new URL(request.url).searchParams;
          const code = params.get("code");
          if (!code) return new Response("missing ?code", { status: 400 });
          // Validate the CSRF state: must match the cookie set when /setup was served.
          const stateParam = params.get("state");
          const cookieHeader = request.headers.get("cookie") ?? "";
          const cookieState = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith("setup_state="))?.slice("setup_state=".length);
          if (!stateParam || !cookieState || stateParam !== cookieState) {
            return new Response("invalid state parameter", { status: 403 });
          }
          try {
            const creds = await exchangeManifestCode(code);
            const outPath = process.env.SETUP_OUTPUT_PATH ?? "/data/gittensory-app.env";
            writeFileSync(outPath, credentialsToEnv(creds), { mode: 0o600 });
            console.log(JSON.stringify({ event: "selfhost_app_created", slug: creds.slug, app_id: creds.id }));
            return new Response(`<!doctype html><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h1>GitHub App created ✓</h1><p>Credentials written to <code>${outPath}</code>. Add them to your <code>.env</code> (or load the file), install the App on your repos, and restart the container.</p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
          } catch (error) {
            return new Response(`setup failed: ${error instanceof Error ? error.message : "error"}`, { status: 500 });
          }
        }
        // Instrument real app traffic — status-class counter + latency histogram. (Infra endpoints
        // /health /ready /metrics and the setup wizard already returned above and are not counted.)
        const startedReq = Date.now();
        const record = (status: number): void => {
          incr("gittensory_http_requests_total", { status: `${Math.floor(status / 100)}xx` });
          observe("gittensory_http_request_duration_seconds", (Date.now() - startedReq) / 1000);
        };
        // Webhook delivery dedup: return 204 immediately for already-processed delivery IDs.
        // We mark only AFTER a successful response — failed/rejected webhooks must be retryable.
        const isWebhook = webhookCache && path === "/v1/github/webhook" && request.method === "POST";
        const deliveryId = isWebhook ? request.headers.get("x-github-delivery") : null;
        if (deliveryId) {
          const seen = await webhookCache!.get(`delivery:${deliveryId}`);
          if (seen) {
            incr("gittensory_webhook_dedup_total");
            record(204);
            return new Response(null, { status: 204 });
          }
        }
        const response = await worker.fetch(request, env, ctx);
        if (deliveryId && response.ok) {
          // Best-effort — never block the response on a cache write failure
          void webhookCache!.set(`delivery:${deliveryId}`, "1", 300).catch(() => undefined);
        }
        record(response.status);
        return response;
      },
      port,
    },
    () => console.log(JSON.stringify({ event: "selfhost_listening", port })),
  );

  backend.queue.start();

  // Cron — gittensory ticks ~every 2 minutes; drive the SAME scheduled handler.
  const intervalMs = Number(process.env.CRON_INTERVAL_MS ?? 120_000);
  const cron = setInterval(() => {
    const controller = { scheduledTime: Date.now(), cron: "*/2 * * * *", noRetry: () => undefined } as unknown as ScheduledController;
    Promise.resolve(worker.scheduled(controller, env, ctx)).catch((error) =>
      console.error(JSON.stringify({ level: "error", event: "selfhost_cron_error", error: error instanceof Error ? error.message : "unknown error" })),
    );
  }, intervalMs);

  // Orb fleet-telemetry export — ALWAYS ON (the fleet-calibration contract of self-hosting). Self-gates
  // inside exportOrbBatch: a no-op until the GitHub App is configured, or when ORB_AIR_GAP=true.
  const runOrbExport = () =>
    exportOrbBatch(backend.db)
      .then((n) => { if (n > 0) console.log(JSON.stringify({ event: "selfhost_orb_export", exported: n })); })
      .catch((error) => console.error(JSON.stringify({ level: "error", event: "selfhost_orb_export_error", error: error instanceof Error ? error.message : "unknown error" })));
  void runOrbExport(); // flush any pending events at startup
  setInterval(runOrbExport, 3_600_000); // then hourly

  // Graceful shutdown: stop accepting HTTP, let the queue finish, close the backend.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "selfhost_shutdown", signal }));
    clearInterval(cron);
    server.close();
    await backend.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
