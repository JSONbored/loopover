// Self-host Node entry (#980). Runs gittensory's SAME Worker handlers on Node. Backends are pluggable:
//   • DB:    SQLite (node:sqlite, default) OR Postgres (DATABASE_URL=postgres://… → shared, multi-instance).
//   • Queue: durable SQLite queue OR a Postgres queue (FOR UPDATE SKIP LOCKED).
//   • Redis: required transient review state + fixed-window rate limiter.
//   • RAG vector store: SQLite/pgvector by default, or Qdrant when QDRANT_URL is set.
// Serves the Hono app via @hono/node-server, drives the queue with the same processJob, ticks the same
// scheduled handler on a timer, exposes /health /ready /metrics, and shuts down gracefully. The Cloudflare
// Worker (src/index.ts) is untouched — this is a parallel entry the self-host esbuild build bundles.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import packageJson from "../package.json";
import worker from "./index";
import { processJob } from "./queue/processors";
import {
  createOpenAiCompatibleAi,
  createSelfHostAi,
  isAiProviderHealthy,
  markAiProviderUnhealthyAtBoot,
  resolveAiReviewerPlan,
  resolveProviderNames,
  resolveRequiredCliProviders,
  resolveSubscriptionCliPath,
  shouldMarkAiProviderUnhealthyAtBoot,
} from "./selfhost/ai";
import {
  cookieValue,
  credentialsToEnv,
  exchangeManifestCode,
  isValidSetupAuthCookie,
  renderBrokeredSetupPage,
  renderSetupPage,
  renderTokenEntryPage,
  setupAuthCookieValue,
  setupTokenFormRejection,
  timingSafeStrEqual,
} from "./selfhost/setup-wizard";
import { isOrbBrokerMode, registerOrbRelayTarget } from "./orb/broker-client";
import { exportOrbBatch } from "./selfhost/orb-collector";
import { createD1Adapter, nodeSqliteDriver } from "./selfhost/d1-adapter";
import {
  buildHealthBody,
  githubAppReadinessProbe,
  readiness,
  resolveHealthVersion,
  sqliteBackupAdvisory,
  type ReadinessProbe,
} from "./selfhost/health";
import { gauge, incr, observe, renderMetrics } from "./selfhost/metrics";
import { runSelfHostMigrations } from "./selfhost/migrate";
import { createPgAdapter, tuneGithubRateLimitObservationsAutovacuum } from "./selfhost/pg-adapter";
import { createPgQueue } from "./selfhost/pg-queue";
import { createPgVectorize, initPgVectorize } from "./selfhost/pg-vectorize";
import { resolvePostgresPoolMax } from "./selfhost/queue-common";
import type { MaintenancePressureSignals } from "./selfhost/maintenance-admission";
import { createSqliteQueue } from "./selfhost/sqlite-queue";
import { createSqliteVectorize } from "./selfhost/vectorize";
import { createFsBlobStore } from "./selfhost/blob-store";
import {
  makeLocalManifestReader,
  makeLocalReviewContextReader,
} from "./selfhost/private-config";
import { assertSelfHostPreflight } from "./selfhost/preflight";
import {
  buildSentryOpenTelemetryBridge,
  captureError,
  flushSentry,
  initSentry,
  installStructuredLogForwarding,
} from "./selfhost/sentry";
import {
  drainOrbRelayWithMonitor,
  runOrbExportWithMonitor,
  runScheduledLoopWithMonitor,
} from "./selfhost/monitored-work";
import {
  currentOtelTraceParent,
  initOpenTelemetry,
  openTelemetryTraceExportEnabled,
  selfHostHttpRequestAttributes,
  selfHostHttpResponseAttributes,
  setCurrentOtelSpanAttributes,
  shutdownOpenTelemetry,
  withOtelSpan,
} from "./selfhost/otel";
import {
  clearSelfHostRequestTraceParent,
  setSelfHostRequestTraceParent,
} from "./selfhost/trace-context";
import {
  setLocalManifestReader,
  setLocalReviewContextReader,
} from "./signals/focus-manifest-loader";
import type { JobMessage } from "./types";

/** Resolve `<NAME>_FILE` env vars (Docker secrets / multi-line keys) into `<NAME>` at startup. */
function loadFileSecrets(): void {
  for (const key of Object.keys(process.env)) {
    if (!key.endsWith("_FILE") || !process.env[key]) continue;
    const target = key.slice(0, -"_FILE".length);
    if (process.env[target]) continue; // an explicit value wins
    try {
      process.env[target] = readFileSync(
        process.env[key] as string,
        "utf8",
      ).trim();
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_secret_file_unreadable",
          var: key,
        }),
      );
    }
  }
}

interface Backend {
  db: D1Database;
  queue: {
    binding: Queue;
    start(): void;
    stop(): Promise<void>;
    size(): number | Promise<number>;
    deadCount(): number | Promise<number>;
    stats(): Record<string, number> | Promise<Record<string, number>>;
    pressureSignals(): MaintenancePressureSignals | Promise<MaintenancePressureSignals>;
  };
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
      if (elapsed >= maxWaitMs)
        throw new Error(
          `Postgres not ready after ${maxWaitMs}ms (${attempt} attempts)`,
        );
      const delay = Math.min(2000, 200 * attempt);
      console.log(
        JSON.stringify({
          event: "selfhost_pg_wait",
          attempt,
          elapsed_ms: elapsed,
          retry_in_ms: delay,
        }),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Retry an async readiness operation with backoff until it succeeds (up to maxWaitMs). Prevents a
 *  crash-restart loop when gittensory starts before a dependency (e.g. Qdrant) is accepting connections —
 *  Qdrant's init is a single fetch with no retry, so a slow-starting --profile qdrant container would
 *  otherwise take the whole process down. */
async function retryUntilReady(
  name: string,
  op: () => Promise<void>,
  maxWaitMs = 30_000,
): Promise<void> {
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
        throw new Error(
          `${name} not ready after ${maxWaitMs}ms (${attempt} attempts): ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      const delay = Math.min(2000, 200 * attempt);
      console.log(
        JSON.stringify({
          event: "selfhost_dependency_wait",
          dependency: name,
          attempt,
          elapsed_ms: elapsed,
          retry_in_ms: delay,
        }),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Build the Postgres backend (shared DB + queue) when DATABASE_URL is a postgres:// URL. */
async function buildPostgresBackend(
  url: string,
  consume: (m: JobMessage) => Promise<void>,
): Promise<Backend> {
  await waitForPostgres(url);
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10)); // int8 (COUNT) → number, like D1
  const pool = new pg.Pool({ connectionString: url, max: resolvePostgresPoolMax() });
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
function buildSqliteBackend(
  consume: (m: JobMessage) => Promise<void>,
): Backend {
  const sqlite = new DatabaseSync(
    process.env.DATABASE_PATH ?? "/data/gittensory.sqlite",
  );
  sqlite.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
  );
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
  /* v8 ignore next -- importing this entrypoint starts the Node server; pure validation is covered in selfhost-preflight tests. */
  assertSelfHostPreflight(process.env);
  // Container-private per-repo config (self-host): register the GITTENSORY_REPO_CONFIG_DIR reader so the focus-
  // manifest loader prefers a mounted `{owner}__{repo}.yml`, deep-merged over an optional root `.gittensory.yml`
  // global default, over the public `.gittensory.yml` (review policy stays private; see
  // config/examples/README.md). Unset dir ⇒ null reader ⇒ unchanged public-fetch behavior.
  setLocalManifestReader(
    makeLocalManifestReader(process.env.GITTENSORY_REPO_CONFIG_DIR),
  );
  // Per-repo review CONTEXT (#review-skills): the same config dir also holds `<repo>/review/AGENTS.md`
  // (or legacy `<repo>/review/CLAUDE.md`) + skills/*.md, injected into the reviewer prompt so reviews follow each
  // repo's conventions. Unset dir ⇒ null reader ⇒ no change.
  setLocalReviewContextReader(
    makeLocalReviewContextReader(process.env.GITTENSORY_REPO_CONFIG_DIR),
  );
  // Error tracking (#1468): opt-in via SENTRY_DSN — a complete no-op when unset. When on, capture uncaught crashes
  // + unhandled rejections (flush before exit for the fatal case); per-subsystem captures (queue dead-letter,
  // review failures) are wired at their sites.
  /* v8 ignore start -- importing this entrypoint starts the Node server; Sentry/OTEL init behavior is covered in selfhost tests. */
  const sentryEnabled = await initSentry(process.env);
  if (sentryEnabled) {
    console.log(
      JSON.stringify({
        event: "selfhost_sentry",
        environment: process.env.SENTRY_ENVIRONMENT ?? "production",
      }),
    );
    process.on("uncaughtException", (error) => {
      captureError(error, { kind: "uncaughtException" });
      console.error(error);
      void flushSentry().finally(() => process.exit(1));
    });
    process.on("unhandledRejection", (reason) => {
      captureError(reason, { kind: "unhandledRejection" });
      console.error(reason);
    });
    // Central error forwarding (#1468): operational failures are structured JSON logs emitted through stdout and
    // stderr. Wrap both sinks so every level:"error"/"fatal" line surfaces as a Sentry issue WITHOUT per-site wiring.
    installStructuredLogForwarding();
  }
  if (await initOpenTelemetry(process.env, sentryEnabled ? await buildSentryOpenTelemetryBridge() : undefined))
    console.log(JSON.stringify({ event: "selfhost_otel", traces: openTelemetryTraceExportEnabled(process.env) ? "otlp" : "sentry" }));
  /* v8 ignore stop */
  const startedAt = Date.now();

  // The queue consumer captures `env`, assigned below (the first job only runs once an HTTP/cron event
  // arrives, by which point env is set).
  let env: Env;
  const consume = async (message: JobMessage): Promise<void> => {
    try {
      await processJob(env, message);
    } catch (error) {
      // Self-host best-effort jobs (#registry-soft-fail): the periodic gittensor-registry refresh re-runs every cron
      // tick, so a degraded/unconfigured GITTENSOR_REGISTRY_URL would otherwise retry→dead-letter EVERY cycle and
      // flood the dead-letter alert. Swallow its failure here (the next scheduled tick is the retry); keep the last
      // snapshot. The Cloudflare Worker path (src/index.ts) is untouched, so its rate-limit-aware retry is preserved.
      if (message.type === "refresh-registry") {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "refresh_registry_soft_fail",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      throw error;
    }
  };

  const databaseUrl = process.env.DATABASE_URL;
  const usePostgres = !!databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl);
  const backend = usePostgres
    ? await buildPostgresBackend(databaseUrl as string, consume)
    : buildSqliteBackend(consume);
  const dbBackend = usePostgres ? "postgres" : "sqlite";
  const healthVersion = resolveHealthVersion(
    { GITTENSORY_VERSION: process.env.GITTENSORY_VERSION },
    packageJson.version,
  );
  console.log(
    JSON.stringify({
      event: "selfhost_backend",
      backend: dbBackend,
    }),
  );
  // Data-safety advisory (#8): warn LOUDLY at boot if running on a single SQLite file with no acknowledged backup,
  // so an operator doesn't run with zero durability while /ready answers 200.
  const backupAdvisory = sqliteBackupAdvisory({
    usingSqlite: !usePostgres,
    backupAcknowledged: process.env.BACKUP_ACKNOWLEDGED === "true",
  });
  if (backupAdvisory)
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "selfhost_backup_advisory",
        message: backupAdvisory,
      }),
    );

  const applied = await runSelfHostMigrations(
    backend.db,
    process.env.MIGRATIONS_DIR ?? "migrations",
  );
  console.log(
    JSON.stringify({ event: "selfhost_migrations_applied", count: applied }),
  );
  // #2543: Postgres-only, applied AFTER migrations (the table must already exist). No-op on SQLite, which has
  // no autovacuum concept at all -- gated on the same usePostgres check the backend was built from.
  if (usePostgres) await tuneGithubRateLimitObservationsAutovacuum(backend.db);

  const ai = createSelfHostAi(process.env);
  if (ai)
    console.log(
      JSON.stringify({
        event: "selfhost_ai_provider",
        provider: process.env.AI_PROVIDER,
      }),
    );
  // Fail-LOUD preflight (#1566): a CLI-subscription provider (claude-code/codex) reviews by spawning the CLI as a
  // subprocess; if the binary is absent (image built without INSTALL_AI_CLIS=true) the spawn ENOENTs and EVERY AI
  // review silently degrades to "no usable output". Shout at boot so the misconfig is obvious, never invisible.
  const pathDirs = resolveSubscriptionCliPath(process.env).split(delimiter);
  const missingCliProviders = new Set<string>();
  for (const { provider, cli } of resolveRequiredCliProviders(process.env)) {
    if (pathDirs.some((d) => d && existsSync(join(d, cli)))) continue;
    missingCliProviders.add(provider);
    console.error(
      JSON.stringify({
        level: "error",
        event: "selfhost_ai_cli_missing",
        provider,
        cli,
        message: `AI_PROVIDER=${process.env.AI_PROVIDER} includes ${provider} but '${cli}' is not on PATH — every ${provider} AI review will produce NO output. Rebuild the image with --build-arg INSTALL_AI_CLIS=true (or use the published image) and authenticate the CLI.`,
      }),
    );
  }
  // Feed into the ai_provider /ready probe (#2497) -- see shouldMarkAiProviderUnhealthyAtBoot for why this is
  // gated on the WHOLE chain being unavailable, not just one missing CLI within a chain that has a working
  // fallback provider.
  if (shouldMarkAiProviderUnhealthyAtBoot(resolveProviderNames(process.env), [...missingCliProviders])) {
    markAiProviderUnhealthyAtBoot();
  }
  // Dedicated RAG embed provider (keeps the review chain frontier-only): when AI_EMBED_BASE_URL is set, embeddings
  // route to a SEPARATE openai-compatible endpoint (e.g. ollama at http://ollama:11434/v1, model bge-m3) instead of
  // the review chain — so a Claude/Codex outage never falls reviews back to a weak local model. Unset ⇒ absent ⇒
  // createReviewAdapters falls back to the review `ai` for embeds (byte-identical to before).
  const embedAi = process.env.AI_EMBED_BASE_URL
    ? createOpenAiCompatibleAi({
        baseUrl: process.env.AI_EMBED_BASE_URL,
        apiKey: process.env.AI_EMBED_API_KEY ?? process.env.OPENAI_API_KEY,
        embedModel: process.env.AI_EMBED_MODEL,
      })
    : undefined;
  if (embedAi)
    console.log(
      JSON.stringify({
        event: "selfhost_embed_provider",
        baseUrl: process.env.AI_EMBED_BASE_URL,
        model: process.env.AI_EMBED_MODEL ?? "bge-m3",
      }),
    );
  // Dual-review plan (#dual-ai-combiner): resolve which provider(s) review + how to combine, attached to env
  // below so the review call site uses it. Undefined for a single provider's default review or no AI.
  const aiReviewPlan = resolveAiReviewerPlan(process.env);
  if (aiReviewPlan)
    console.log(
      JSON.stringify({
        event: "selfhost_ai_review_plan",
        reviewers: aiReviewPlan.reviewers.map((r) => r.model),
        combine: aiReviewPlan.combine,
      }),
    );

  // /ready gates on required Redis plus every configured optional backend so a load balancer never routes to an
  // instance whose shared state/vector backend is down. Each probe owns a short timeout so a hung backend can't
  // hang the readiness check.
  const readinessProbes: ReadinessProbe[] = [];
  const withTimeout = (p: Promise<boolean>, ms = 1500): Promise<boolean> =>
    Promise.race([
      p,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  // Redis is required: pending-CI stuck detection, webhook dedup/coalescing, distributed rate limiting, and
  // warm GitHub token/response caches all rely on this shared transient state.
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for the self-host review runtime");
  const { Redis } = await import("ioredis");
  const redisClient = new Redis(redisUrl);
  const { createRedisRateLimiter } = await import("./selfhost/redis-ratelimit");
  const { createRedisCache } = await import("./selfhost/redis-cache");
  const rateLimiter = createRedisRateLimiter(redisClient);
  const webhookCache = createRedisCache(redisClient);
  // Persist the installation-token cache in Redis so warm GitHub App tokens survive restarts/deploys and are
  // shared across replicas (the in-isolate Map otherwise re-mints — an Orb round-trip — per replica/cold start).
  const { createRedisTokenCache } = await import("./selfhost/redis-token-cache");
  const { createAppJwt, setInstallationTokenStore, setGitHubResponseCache } = await import("./github/app");
  setInstallationTokenStore(createRedisTokenCache(redisClient));
  // Configured AI provider: gate on the chain's own consecutive-exhaustion streak (isAiProviderHealthy) rather
  // than a live reachability probe, which would cost a real API/CLI call on every health-check tick. Only
  // registered when a provider is actually configured -- without AI_PROVIDER reviews run deterministically,
  // which is not a degraded state (#2497). A missing required CLI binary is caught immediately at boot (see
  // markAiProviderUnhealthyAtBoot above) -- for everything else (a bad HTTP-provider API key, an unreachable
  // endpoint), the streak is historical, not live: it only updates as real review traffic exercises the
  // chain, so a freshly booted instance with those specific misconfigurations reports healthy before its
  // first AI call, and a fix only clears after a subsequent success, not instantly. Verifying an HTTP
  // provider's credentials cheaply at boot would mean spending a real network call, which this probe design
  // deliberately avoids paying on every health-check tick.
  if (ai) {
    readinessProbes.push({
      name: "ai_provider",
      check: () => Promise.resolve(isAiProviderHealthy()),
    });
  }
  // Enable/disable gate for the GitHub GET-response cache (dedups the ~24 reads per review); NOT a per-entry
  // TTL — each cached class (branch-protection/metadata/commit/GraphQL) resolves its own TTL env var, so the
  // value here only matters as >0 (enabled) vs 0 (disabled) (#2505).
  const ghCacheTtl = Math.max(0, Number(process.env.GITHUB_CACHE_TTL_SECONDS ?? "20"));
  if (ghCacheTtl > 0) {
    const { createRedisResponseCache } = await import("./selfhost/redis-response-cache");
    setGitHubResponseCache(createRedisResponseCache(redisClient));
  }
  readinessProbes.push({
    name: "redis",
    check: () => withTimeout(redisClient.ping().then(() => true)),
  });
  console.log(
    JSON.stringify({
      event: "selfhost_redis_ready",
      backend: "redis",
      githubResponseCacheEnabled: ghCacheTtl > 0,
    }),
  );

  // Qdrant vector store — overrides the backend's built-in sqlite-vec / pgvector when QDRANT_URL is set.
  let vectorizeOverride: Vectorize | undefined;
  if (process.env.QDRANT_URL) {
    const qdrantUrl = process.env.QDRANT_URL;
    const { createQdrantVectorize, initQdrantCollection, qdrantReadyzUrl } =
      await import("./selfhost/qdrant-vectorize");
    // Retry until Qdrant accepts the collection PUT — the container may still be booting when we start.
    await retryUntilReady("qdrant", () => initQdrantCollection(qdrantUrl));
    vectorizeOverride = createQdrantVectorize(qdrantUrl);
    readinessProbes.push({
      name: "qdrant",
      check: () =>
        withTimeout(
          fetch(qdrantReadyzUrl(qdrantUrl), {
            signal: AbortSignal.timeout(1500),
          })
            .then((r) => r.ok)
            .catch(() => false),
        ),
    });
    console.log(
      JSON.stringify({ event: "selfhost_vectorize", backend: "qdrant" }),
    );
  }

  env = {
    ...process.env,
    DB: backend.db,
    JOBS: backend.queue.binding,
    WEBHOOKS: backend.queue.binding, // the brokered relay receiver enqueues via WEBHOOKS; both lanes share the in-process queue
    AI: ai,
    ...(embedAi ? { AI_EMBED: embedAi as unknown as Ai } : {}),
    ...(aiReviewPlan ? { AI_REVIEW_PLAN: aiReviewPlan } : {}),
    SELFHOST_TRANSIENT_CACHE: webhookCache,
    // Qdrant takes priority; falls back to the backend's built-in vectorize (pgvector or sqlite-vec)
    ...(vectorizeOverride
      ? { VECTORIZE: vectorizeOverride }
      : backend.vectorize
        ? { VECTORIZE: backend.vectorize }
        : {}),
    RATE_LIMITER: rateLimiter,
    // Visual review: when BROWSER_WS_ENDPOINT is set, expose a truthy BROWSER binding so shot.ts's
    // `if (!env.BROWSER) return` guard is bypassed; the puppeteer stub then connects via WS.
    ...(process.env.BROWSER_WS_ENDPOINT ? { BROWSER: {} } : {}),
    // Visual screenshot persistence (#10): bind an fs-backed REVIEW_AUDIT store when REVIEW_AUDIT_DIR is set so
    // captured PNGs are cached + served from /gittensory/shot?key=… instead of re-rendering on demand. Unset ⇒
    // no binding ⇒ on-demand behavior, byte-identical to before.
    ...(process.env.REVIEW_AUDIT_DIR
      ? { REVIEW_AUDIT: createFsBlobStore(process.env.REVIEW_AUDIT_DIR) }
      : {}),
  } as unknown as Env;

  // GitHub App auth: a successful JWT mint proves GITHUB_APP_PRIVATE_KEY is set and parses as a valid signing
  // key. Without this, an invalid/expired key leaves the review pipeline completely dead while /ready still
  // reports 200 — detection otherwise requires SENTRY_DSN or grepping stdout for auth errors (#2497). The
  // register/fail-closed decision lives in githubAppReadinessProbe (unit-tested there); withTimeout here is
  // only the hung-mint guard shared with the other probes. Reads from `env` (not process.env) -- the SAME
  // object createAppJwt(env) actually mints against below -- so the registration decision and the live mint
  // can never diverge; registered here, after env is fully constructed, rather than off the raw process.env
  // snapshot read earlier in this function (flagged by the gate's own review as a real risk: two different
  // sources of truth for the same credential, even if they happen to agree today).
  const githubAppProbe = githubAppReadinessProbe(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    () => createAppJwt(env),
  );
  if (githubAppProbe) {
    readinessProbes.push({
      name: githubAppProbe.name,
      check: () => withTimeout(githubAppProbe.check()),
    });
  }

  gauge("gittensory_queue_pending", () => backend.queue.size());
  gauge("gittensory_queue_dead", () => backend.queue.deadCount());
  const durableJobMetric = async (name: string): Promise<number> =>
    Number((await backend.queue.stats())[name] ?? 0);
  for (const name of [
    "gittensory_jobs_enqueued_total",
    "gittensory_jobs_processed_total",
    "gittensory_jobs_failed_total",
    "gittensory_jobs_dead_total",
    "gittensory_jobs_rate_limited_total",
    "gittensory_jobs_rate_limit_deferred_total",
    "gittensory_jobs_coalesced_total",
    "gittensory_jobs_recovered_total",
    "gittensory_jobs_maintenance_admission_deferred_total",
  ]) {
    gauge(name.replace("_total", "_persisted_total"), () =>
      durableJobMetric(name),
    );
  }
  // Runtime-pressure gauges (#selfhost-runtime-pressure): the SAME signals the maintenance-admission policy
  // consults at claim time (see maintenance-admission.ts), so the dashboard shows exactly what's gating
  // maintenance work right now -- live vs. maintenance queue depth, how stale the oldest of each is, and
  // (best-effort) host CPU pressure. Distinguishes "the app queue is backed up" from "CI/other host load is
  // starving the app" from "GitHub/AI latency", the ambiguity that made the original slowdown hard to diagnose.
  const maintenancePressure = () => backend.queue.pressureSignals();
  gauge("gittensory_queue_live_pending", async () => (await maintenancePressure()).livePendingCount);
  gauge("gittensory_queue_maintenance_pending", async () => (await maintenancePressure()).maintenancePendingCount);
  gauge("gittensory_queue_oldest_live_pending_age_seconds", async () =>
    Math.floor(((await maintenancePressure()).oldestLivePendingAgeMs ?? 0) / 1000),
  );
  gauge("gittensory_queue_oldest_maintenance_pending_age_seconds", async () =>
    Math.floor(((await maintenancePressure()).oldestMaintenancePendingAgeMs ?? 0) / 1000),
  );
  // -1 (not 0) when unavailable -- a genuine idle host reads 0, so a dashboard can tell "known idle" apart
  // from "no signal on this platform" (see host-pressure.ts).
  gauge("gittensory_host_load_avg1_per_core", async () => (await maintenancePressure()).hostLoadAvg1PerCore ?? -1);
  gauge("gittensory_uptime_seconds", () =>
    Math.floor((Date.now() - startedAt) / 1000),
  );
  // Pre-initialize job counters to 0 so they appear in the first Prometheus scrape (lazy counters
  // created on first use would otherwise cause "No data" in Grafana until the first job event).
  for (const c of [
    "gittensory_jobs_enqueued_total",
    "gittensory_jobs_processed_total",
    "gittensory_jobs_failed_total",
    "gittensory_jobs_dead_total",
    "gittensory_jobs_rate_limit_deferred_total",
    "gittensory_jobs_recovered_total",
    "gittensory_webhook_dedup_total",
    "gittensory_qdrant_queries_total",
    "gittensory_qdrant_upserts_total",
    "gittensory_orb_events_exported_total",
    "gittensory_orb_export_errors_total",
  ])
    incr(c, undefined, 0);
  // Seed gittensory_http_requests_total per status class so the breakdown panel has every series from the
  // first scrape (keeping the metric consistently labeled — never mix labeled and unlabeled samples).
  for (const status of ["2xx", "3xx", "4xx", "5xx"])
    incr("gittensory_http_requests_total", { status }, 0);

  const ctx = {
    waitUntil: (p: Promise<unknown>) =>
      void Promise.resolve(p).catch(() => undefined),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const port = Number(process.env.PORT ?? 8787);
  const server = serve(
    {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/health")
          return new Response(
            JSON.stringify(buildHealthBody({ version: healthVersion, startedAt, dbBackend })),
            { headers: { "content-type": "application/json" } },
          );
        if (path === "/ready") {
          const r = await readiness(backend.db, readinessProbes);
          return new Response(JSON.stringify(r), {
            status: r.ok ? 200 : 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/metrics")
          return new Response(await renderMetrics(), {
            headers: { "content-type": "text/plain; version=0.0.4" },
          });
        // Brokered mode (ORB_ENROLLMENT_SECRET set): the central Orb App provides credentials on demand, so
        // there is no own GitHub App to create — short-circuit the setup wizard to a brokered-mode page rather
        // than walking the operator through (and overriding with) an own-App setup they don't need.
        if (
          (path === "/setup" || path === "/setup/callback") &&
          isOrbBrokerMode({
            ORB_ENROLLMENT_SECRET: process.env.ORB_ENROLLMENT_SECRET,
          })
        ) {
          return new Response(renderBrokeredSetupPage(), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "Referrer-Policy": "no-referrer",
            },
          });
        }
        // First-run GitHub App setup wizard — only while no App is configured (can't rebind a live install).
        if (
          (path === "/setup" || path === "/setup/callback") &&
          !process.env.GITHUB_APP_ID
        ) {
          const setupToken = process.env.SELFHOST_SETUP_TOKEN;
          if (!setupToken) {
            return new Response(
              "SELFHOST_SETUP_TOKEN must be set before using the setup wizard",
              { status: 400 },
            );
          }
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
            // Token via header (programmatic) or the POST form body (browser) — NEVER the URL query string,
            // which would leak the secret to access logs, proxies, and browser history.
            let suppliedToken =
              request.headers.get("x-setup-token") ??
              request.headers
                .get("authorization")
                ?.replace(/^Bearer\s+/i, "") ??
              "";
            if (!suppliedToken && request.method === "POST") {
              const rejection = setupTokenFormRejection(request.headers);
              if (rejection) return rejection;
              const form = await request.formData().catch(() => null);
              const field = form?.get("token");
              suppliedToken = typeof field === "string" ? field : "";
            }
            if (!timingSafeStrEqual(suppliedToken, setupToken)) {
              // Not authenticated → show the token-entry form (token submitted via POST body, not the URL).
              // First visit (no token) is 200; a wrong submission is 403.
              return new Response(
                renderTokenEntryPage(suppliedToken.length > 0),
                {
                  status: suppliedToken.length > 0 ? 403 : 200,
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    "Referrer-Policy": "no-referrer",
                  },
                },
              );
            }
            // Generate a per-visit CSRF nonce, embed it in the manifest's redirect_url, and bind it to
            // this browser session via an HttpOnly signed cookie so the callback can validate it came
            // from an operator-authorized setup visit, not just any unauthenticated browser.
            const state = randomUUID();
            return new Response(renderSetupPage(origin, state), {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "Referrer-Policy": "no-referrer",
                "Set-Cookie": `setup_auth=${setupAuthCookieValue(setupToken, state)}; Path=/setup; HttpOnly; SameSite=Lax; Max-Age=3600`,
              },
            });
          }
          const params = new URL(request.url).searchParams;
          const code = params.get("code");
          if (!code) return new Response("missing ?code", { status: 400 });
          // Validate the CSRF state: must match the cookie set when /setup was served.
          const stateParam = params.get("state");
          const cookieHeader = request.headers.get("cookie") ?? "";
          const setupAuth = cookieValue(cookieHeader, "setup_auth");
          if (
            !stateParam ||
            !isValidSetupAuthCookie(setupToken, stateParam, setupAuth)
          ) {
            return new Response("invalid state parameter", { status: 403 });
          }
          try {
            const creds = await exchangeManifestCode(code);
            const outPath =
              process.env.SETUP_OUTPUT_PATH ?? "/data/gittensory-app.env";
            writeFileSync(outPath, credentialsToEnv(creds), { mode: 0o600 });
            console.log(
              JSON.stringify({
                event: "selfhost_app_created",
                slug: creds.slug,
                app_id: creds.id,
              }),
            );
            return new Response(
              `<!doctype html><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h1>GitHub App created ✓</h1><p>Credentials written to <code>${outPath}</code>. Add them to your <code>.env</code> (or load the file), install the App on your repos, and restart the container.</p></body>`,
              { headers: { "content-type": "text/html; charset=utf-8" } },
            );
          } catch (error) {
            return new Response(
              `setup failed: ${error instanceof Error ? error.message : "error"}`,
              { status: 500 },
            );
          }
        }
        return await withOtelSpan(
          "selfhost.http.request",
          selfHostHttpRequestAttributes(request, path),
          async () => {
            const traceParent = currentOtelTraceParent();
            if (traceParent) setSelfHostRequestTraceParent(request, traceParent);
            try {
              // Instrument real app traffic — status-class counter + latency histogram. (Infra endpoints
              // /health /ready /metrics and the setup wizard already returned above and are not counted.)
              const startedReq = Date.now();
              const finish = (response: Response): Response => {
                incr("gittensory_http_requests_total", {
                  status: `${Math.floor(response.status / 100)}xx`,
                });
                observe(
                  "gittensory_http_request_duration_seconds",
                  (Date.now() - startedReq) / 1000,
                );
                setCurrentOtelSpanAttributes(selfHostHttpResponseAttributes(response.status));
                return response;
              };
              // Webhook delivery dedup: return 204 immediately for already-processed delivery IDs.
              // We mark only AFTER a successful response — failed/rejected webhooks must be retryable.
              const isWebhook =
                webhookCache &&
                path === "/v1/github/webhook" &&
                request.method === "POST";
              const deliveryId = isWebhook
                ? request.headers.get("x-github-delivery")
                : null;
              if (deliveryId) {
                const seen = await webhookCache!.get(`delivery:${deliveryId}`);
                if (seen) {
                  incr("gittensory_webhook_dedup_total");
                  return finish(new Response(null, { status: 204 }));
                }
              }
              const response = await worker.fetch(request, env, ctx);
              if (deliveryId && response.ok) {
                // Best-effort — never block the response on a cache write failure
                void webhookCache!
                  .set(`delivery:${deliveryId}`, "1", 300)
                  .catch(() => undefined);
              }
              return finish(response);
            } finally {
              clearSelfHostRequestTraceParent(request);
            }
          },
        );
      },
      port,
    },
    () => console.log(JSON.stringify({ event: "selfhost_listening", port })),
  );

  backend.queue.start();

  // Cron — gittensory ticks ~every 2 minutes; drive the SAME scheduled handler.
  const intervalMs = Number(process.env.CRON_INTERVAL_MS ?? 120_000);
  /* v8 ignore start -- self-host entrypoint timers start a live server; monitor semantics are covered in selfhost tests. */
  const cron = setInterval(() => {
    const controller = {
      scheduledTime: Date.now(),
      cron: "*/2 * * * *",
      noRetry: () => undefined,
    } as unknown as ScheduledController;
    runScheduledLoopWithMonitor(controller.cron, () =>
      worker.scheduled(controller, env, ctx),
    ).catch((error) =>
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_cron_error",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      ),
    );
  }, intervalMs);
  /* v8 ignore stop */

  // Orb fleet-telemetry export — ALWAYS ON (the fleet-calibration contract of self-hosting). Self-gates
  // inside exportOrbBatch: a no-op until the GitHub App is configured, or when ORB_AIR_GAP=true.
  /* v8 ignore start -- self-host entrypoint timers start a live server; monitor semantics are covered in selfhost tests. */
  const runOrbExport = () =>
    runOrbExportWithMonitor(() => exportOrbBatch(backend.db)).catch((error) =>
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_orb_export_error",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      ),
    );
  void runOrbExport(); // flush any pending events at startup
  setInterval(runOrbExport, 3_600_000); // then hourly
  /* v8 ignore stop */

  // Brokered self-host: register our relay target with the central Orb (best-effort, fire-and-forget). PUSH mode
  // (default) registers a public relay URL the Orb POSTs to; PULL mode (ORB_RELAY_MODE=pull) registers no URL and
  // the drain loop below pulls events outbound — the right fit behind NAT/tailnet (no inbound endpoint exposed).
  void registerOrbRelayTarget({
    ORB_ENROLLMENT_SECRET: process.env.ORB_ENROLLMENT_SECRET,
    ORB_BROKER_URL: process.env.ORB_BROKER_URL,
    PUBLIC_API_ORIGIN: process.env.PUBLIC_API_ORIGIN,
    ORB_RELAY_MODE: process.env.ORB_RELAY_MODE,
  })
    .then((r) => {
      if (r.status === "registered") {
        console.log(JSON.stringify({ event: "selfhost_orb_relay_register", result: r.status }));
      } else if (r.status === "failed") {
        // A failed registration is fatal for PUSH mode (the Orb can't reach our public relay URL → the container
        // looks alive but reviews NOTHING → error). In PULL mode the outbound drain loop below delivers events
        // regardless, so a failed announce is only degraded telemetry → warn (not paged as a deaf container).
        // Either way carry the reason (HTTP status / fetch error) in `error` so Sentry shows WHY, not "(no message)".
        const pull = process.env.ORB_RELAY_MODE === "pull";
        console.error(
          JSON.stringify({
            level: pull ? "warn" : "error",
            event: "selfhost_orb_relay_register_failed",
            mode: pull ? "pull" : "push",
            error: r.reason ?? "unknown",
          }),
        );
      }
    })
    .catch((error) => captureError(error, { kind: "orb_relay_register" }));

  // Pull-mode relay drain (#secure-relay): when ORB_RELAY_MODE=pull, the engine DRAINS its events from the Orb on a
  // timer instead of exposing an inbound endpoint — the right fit behind NAT/tailnet. Acks the previous batch so the
  // Orb deletes delivered events; best-effort (a failed tick retries next interval). Each event enqueues into the
  // same WEBHOOKS lane the push receiver uses.
  if (process.env.ORB_RELAY_MODE === "pull" && process.env.ORB_ENROLLMENT_SECRET) {
    const { drainOrbRelay } = await import("./orb/broker-client");
    const { enqueueWebhookByEnv } = await import("./github/webhook");
    const relayDrainState = { pendingAck: [] as string[] };
    /* v8 ignore start -- pull-mode relay loop is a live self-host timer; monitor semantics are covered in selfhost tests. */
    const drainRelay = async (): Promise<void> => {
      await drainOrbRelayWithMonitor({
        state: relayDrainState,
        relayEnv: {
          ORB_ENROLLMENT_SECRET: process.env.ORB_ENROLLMENT_SECRET,
          ORB_BROKER_URL: process.env.ORB_BROKER_URL,
        },
        env,
        drain: drainOrbRelay,
        enqueue: enqueueWebhookByEnv,
      });
    };
    void drainRelay();
    setInterval(
      () =>
        void drainRelay().catch((error) =>
          captureError(error, { kind: "orb_relay_drain" }),
        ),
      15_000,
    );
    /* v8 ignore stop */
  }

  // Graceful shutdown: stop accepting HTTP, let the queue finish, close the backend.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "selfhost_shutdown", signal }));
    clearInterval(cron);
    server.close();
    await backend.shutdown();
    /* v8 ignore next -- graceful process signal path is not imported in unit tests; shutdown helper is covered. */
    await shutdownOpenTelemetry();
    await flushSentry();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  captureError(error, { kind: "boot" });
  console.error(error);
  /* v8 ignore next -- boot failure exits the process; shutdown helper is covered independently. */
  void Promise.all([shutdownOpenTelemetry(), flushSentry()]).finally(() => process.exit(1));
});
