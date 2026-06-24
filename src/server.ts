// Self-host Node entry (#980). Runs gittensory's SAME Worker handlers on Node: builds an `Env` where the
// Cloudflare bindings are self-host adapters (D1→node:sqlite, Queue→a durable SQLite-backed queue), serves
// the Hono app via @hono/node-server, drains the queue with the same processJob, and ticks the same scheduled
// handler on a timer. Adds operational endpoints (/health, /ready, /metrics) and graceful shutdown. The
// Cloudflare Worker (src/index.ts) is untouched — this is a parallel entry the self-host esbuild build bundles
// (aliasing `cloudflare:workers` to the shim).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import worker from "./index";
import { processJob } from "./queue/processors";
import { createSelfHostAi } from "./selfhost/ai";
import { createD1Adapter, nodeSqliteDriver } from "./selfhost/d1-adapter";
import { readiness } from "./selfhost/health";
import { gauge, incr, renderMetrics } from "./selfhost/metrics";
import { runSelfHostMigrations } from "./selfhost/migrate";
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

async function main(): Promise<void> {
  loadFileSecrets();
  const startedAt = Date.now();

  const sqlite = new DatabaseSync(process.env.DATABASE_PATH ?? "/data/gittensory.sqlite");
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const driver = nodeSqliteDriver(sqlite as never);
  const db = createD1Adapter(driver);
  const applied = await runSelfHostMigrations(db, process.env.MIGRATIONS_DIR ?? "migrations");
  console.log(JSON.stringify({ event: "selfhost_migrations_applied", count: applied }));

  // Durable queue — jobs persist in SQLite, so a restart re-claims in-flight work. The consumer captures
  // `env`, assigned just below (the first job only runs once an HTTP/cron event arrives, by which point env is set).
  let env: Env;
  const queue = createSqliteQueue(driver, async (message: JobMessage) => {
    await processJob(env, message);
  });

  // AI: the OpenAI-compatible / subscription adapter selected by AI_PROVIDER (undefined when unconfigured →
  // gittensory's AI summary degrades to "unavailable" and the review proceeds deterministically).
  const ai = createSelfHostAi(process.env);
  if (ai) console.log(JSON.stringify({ event: "selfhost_ai_provider", provider: process.env.AI_PROVIDER }));
  // Vector store for RAG (gated by GITTENSORY_REVIEW_RAG + the repo allowlist + an embedding-capable provider);
  // a SQLite-backed Vectorize so retrieval works without Cloudflare Vectorize.
  const vectorize = createSqliteVectorize(driver);
  env = { ...process.env, DB: db, JOBS: queue.binding, AI: ai, VECTORIZE: vectorize } as unknown as Env;

  gauge("gittensory_queue_pending", () => queue.size());
  gauge("gittensory_queue_dead", () => queue.deadCount());
  gauge("gittensory_uptime_seconds", () => Math.floor((Date.now() - startedAt) / 1000));

  const ctx = {
    waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => undefined),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const port = Number(process.env.PORT ?? 8787);
  const server = serve(
    {
      fetch: (request: Request) => {
        const path = new URL(request.url).pathname;
        // Binding-free liveness (the Hono app also exempts /health from auth + rate-limit).
        if (path === "/health") return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } });
        if (path === "/ready") {
          const r = readiness(driver);
          return new Response(JSON.stringify(r), { status: r.ok ? 200 : 503, headers: { "content-type": "application/json" } });
        }
        if (path === "/metrics") return new Response(renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } });
        incr("gittensory_http_requests_total");
        return worker.fetch(request, env, ctx);
      },
      port,
    },
    () => console.log(JSON.stringify({ event: "selfhost_listening", port })),
  );

  queue.start();

  // Cron — gittensory ticks ~every 2 minutes; drive the SAME scheduled handler.
  const intervalMs = Number(process.env.CRON_INTERVAL_MS ?? 120_000);
  const cron = setInterval(() => {
    const controller = { scheduledTime: Date.now(), cron: "*/2 * * * *", noRetry: () => undefined } as unknown as ScheduledController;
    Promise.resolve(worker.scheduled(controller, env, ctx)).catch((error) =>
      console.error(JSON.stringify({ level: "error", event: "selfhost_cron_error", error: error instanceof Error ? error.message : "unknown error" })),
    );
  }, intervalMs);

  // Graceful shutdown: stop accepting HTTP, let the queue finish its in-flight job, checkpoint WAL, close DB.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "selfhost_shutdown", signal }));
    clearInterval(cron);
    server.close();
    await queue.stop();
    try {
      sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      sqlite.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
