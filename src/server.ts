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
import { createD1Adapter, nodeSqliteDriver } from "./selfhost/d1-adapter";
import { readiness } from "./selfhost/health";
import { gauge, incr, renderMetrics } from "./selfhost/metrics";
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

/** Build the Postgres backend (shared DB + queue) when DATABASE_URL is a postgres:// URL. */
async function buildPostgresBackend(url: string, consume: (m: JobMessage) => Promise<void>): Promise<Backend> {
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

  // Redis fixed-window rate limiter (else absent → enforceRateLimit is a no-op, as today).
  let rateLimiter: DurableObjectNamespace | undefined;
  if (process.env.REDIS_URL) {
    const { Redis } = await import("ioredis");
    const { createRedisRateLimiter } = await import("./selfhost/redis-ratelimit");
    rateLimiter = createRedisRateLimiter(new Redis(process.env.REDIS_URL));
    console.log(JSON.stringify({ event: "selfhost_rate_limiter", backend: "redis" }));
  }

  env = {
    ...process.env,
    DB: backend.db,
    JOBS: backend.queue.binding,
    AI: ai,
    ...(backend.vectorize ? { VECTORIZE: backend.vectorize } : {}),
    ...(rateLimiter ? { RATE_LIMITER: rateLimiter } : {}),
    // Visual review: when BROWSER_WS_ENDPOINT is set, expose a truthy BROWSER binding so shot.ts's
    // `if (!env.BROWSER) return` guard is bypassed; the puppeteer stub then connects via WS.
    ...(process.env.BROWSER_WS_ENDPOINT ? { BROWSER: {} } : {}),
  } as unknown as Env;

  gauge("gittensory_queue_pending", () => backend.queue.size());
  gauge("gittensory_queue_dead", () => backend.queue.deadCount());
  gauge("gittensory_uptime_seconds", () => Math.floor((Date.now() - startedAt) / 1000));

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
          const origin = process.env.PUBLIC_API_ORIGIN ?? new URL(request.url).origin;
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
        incr("gittensory_http_requests_total");
        return worker.fetch(request, env, ctx);
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
