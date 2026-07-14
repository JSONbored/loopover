import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { generateAnonSecret, hmacAnonymize as engineHmacAnonymize } from "@loopover/engine";
import { readPrOutcomes } from "./pr-outcome.js";
import { initEventLedger } from "./event-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

// Optional anonymized Orb telemetry export (#4277, network send wired in #5681). The self-host Orb collector
// (src/selfhost/orb-collector.ts, #1255) is ALWAYS-ON for a maintainer's own instance; a miner runs on a
// third-party contributor's laptop with a much lower consent bar, so this export is OPT-IN (default OFF) —
// hence "optional". It mirrors the collector's privacy posture: repo/PR identifiers are HMAC-anonymized with a
// per-instance DEDICATED secret (generated once, persisted locally, single-purpose), and only a fixed
// low-cardinality reason bucket + the decision leave — never raw repo names or free text. The data source is
// the local pr_outcome ledger (pr-outcome.js), not a hosted D1. `generateAnonSecret`/`hmacAnonymize` are the
// same primitive src/selfhost/orb-collector.ts uses (@loopover/engine, #5680) — one anonymization
// implementation shared by both products instead of two independently-maintained copies.

/** OPT-IN: a laptop miner exports nothing unless a contributor explicitly turns it on. */
export const ORB_EXPORT_ENABLED_BY_DEFAULT = false;

const ANON_SECRET_KEY = "anon_secret";
const CURSOR_KEY = "export_cursor";
const defaultDbFileName = "orb-export.sqlite3";

export function resolveOrbExportDbPath(env = process.env) {
  const explicitPath =
    typeof env.LOOPOVER_MINER_ORB_EXPORT_DB === "string" ? env.LOOPOVER_MINER_ORB_EXPORT_DB.trim() : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir =
    typeof env.LOOPOVER_MINER_CONFIG_DIR === "string" ? env.LOOPOVER_MINER_CONFIG_DIR.trim() : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
      ? env.XDG_CONFIG_HOME.trim()
      : join(homedir(), ".config");
  return join(configHome, "loopover-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolveOrbExportDbPath()).trim();
  if (!path) throw new Error("invalid_orb_export_db_path");
  return path;
}

/** HMAC a value with the per-instance secret. Validates the secret (the shared engine primitive stays pure
 *  and doesn't), then delegates the actual hash to @loopover/engine's hmacAnonymize — the same primitive
 *  src/selfhost/orb-collector.ts uses, so both products anonymize identically. */
export function hmacAnonymize(value, secret) {
  if (typeof secret !== "string" || !secret) throw new Error("invalid_anon_secret");
  return engineHmacAnonymize(String(value), secret);
}

/**
 * Turn the local pr_outcome map (pr-outcome.js `readPrOutcomes`) into an anonymized export batch: repo and PR
 * identifiers are HMAC-hashed, and only the `decision` + a low-cardinality `reasonBucket` (already one of the
 * miner's `REJECTION_REASONS`, else `"none"`) + `closedAt` leave. Pure and deterministic (rows sorted by prHash).
 * Accepts either the Map `readPrOutcomes` returns or any iterable of outcome records.
 */
export function buildAnonymizedOrbBatch(outcomes, secret) {
  const iterable = outcomes && typeof outcomes.values === "function" ? outcomes.values() : outcomes;
  const rows = [];
  for (const outcome of iterable ?? []) {
    if (!outcome || typeof outcome.repoFullName !== "string" || !outcome.repoFullName.trim()) continue;
    if (!Number.isInteger(outcome.prNumber) || outcome.prNumber <= 0) continue;
    rows.push({
      repoHash: hmacAnonymize(outcome.repoFullName, secret),
      prHash: hmacAnonymize(`${outcome.repoFullName}:${outcome.prNumber}`, secret),
      decision: outcome.decision,
      reasonBucket: typeof outcome.reason === "string" && outcome.reason ? outcome.reason : "none",
      closedAt: typeof outcome.closedAt === "string" && outcome.closedAt ? outcome.closedAt : null,
    });
  }
  rows.sort((a, b) => a.prHash.localeCompare(b.prHash));
  return rows;
}

/**
 * Open/create the local orb-export store: a small key/value SQLite table holding the per-instance anonymization
 * secret and the export cursor. Mirrors the other miner ledgers' node:sqlite pattern — a `0o700` config dir and a
 * `0o600` file, since the secret must never leave this machine.
 */
export function openOrbExportStore(dbPath = resolveOrbExportDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS orb_export_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const getStatement = db.prepare("SELECT value FROM orb_export_meta WHERE key = ?");
  const setStatement = db.prepare(
    "INSERT INTO orb_export_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const readValue = (key) => {
    const row = getStatement.get(key);
    return row && typeof row.value === "string" ? row.value : null;
  };

  return {
    dbPath: resolvedPath,
    /** The per-instance DEDICATED anonymization secret — generated once (256-bit) and persisted, then reused
     *  forever so a repo/PR always hashes the same way. Single-purpose: only this export uses it. */
    getOrCreateAnonSecret() {
      const existing = readValue(ANON_SECRET_KEY);
      if (existing) return existing;
      const generated = generateAnonSecret();
      setStatement.run(ANON_SECRET_KEY, generated);
      return generated;
    },
    /** The export watermark (opaque string), or null before the first export. */
    getCursor() {
      return readValue(CURSOR_KEY);
    },
    setCursor(cursor) {
      setStatement.run(CURSOR_KEY, String(cursor));
    },
    close() {
      db.close();
    },
  };
}

/**
 * Collect the anonymized Orb export batch from the local pr_outcome ledger. OPT-IN: returns null (exports nothing)
 * unless `enabled` is true — a third-party contributor's laptop must explicitly turn this on. Never performs the
 * network POST itself; the caller sends the returned batch to the Orb ingest endpoint and then advances the store
 * cursor, so this function stays pure over its inputs and the local store.
 */
export function collectOrbExportBatch({ store, eventLedger, enabled = ORB_EXPORT_ENABLED_BY_DEFAULT } = {}) {
  if (!enabled) return null;
  if (!store || typeof store.getOrCreateAnonSecret !== "function") throw new Error("invalid_orb_export_store");
  const outcomes = readPrOutcomes(eventLedger);
  return buildAnonymizedOrbBatch(outcomes, store.getOrCreateAnonSecret());
}

/** Stable per-instance identifier: a hash of the instance's own anon secret (no App-id concept on the AMS side,
 *  unlike orb-collector.ts's instanceId — a miner laptop has no GitHub App). */
export function amsInstanceId(secret) {
  return createHash("sha256").update(String(secret)).digest("hex").slice(0, 16);
}

/** Drop rows already sent in a prior export: everything with a `closedAt` at/before the cursor. A row with no
 *  `closedAt` (shouldn't happen for a resolved PR, but defensive) is always included, since there is no
 *  watermark to compare it against. A null/unset cursor means "first export" — everything goes. */
export function filterBatchSinceCursor(batch, cursor) {
  if (!cursor) return batch;
  return batch.filter((row) => !row.closedAt || row.closedAt > cursor);
}

/** The newest `closedAt` among a batch's rows, or `null` if none carry one — the next cursor value to persist
 *  after a successful send. */
export function latestClosedAt(batch) {
  let latest = null;
  for (const row of batch) {
    if (row.closedAt && (latest === null || row.closedAt > latest)) latest = row.closedAt;
  }
  return latest;
}

/** gittensory's hosted AMS collector — mirrors orb-collector.ts's ORB_COLLECTOR_URL default pattern. */
export const DEFAULT_AMS_COLLECTOR_URL = "https://api.loopover.ai/v1/ams/ingest";

export function resolveAmsCollectorUrl(env = process.env) {
  const explicit = typeof env.LOOPOVER_MINER_AMS_COLLECTOR_URL === "string" ? env.LOOPOVER_MINER_AMS_COLLECTOR_URL.trim() : "";
  return explicit || DEFAULT_AMS_COLLECTOR_URL;
}

/**
 * POST an already-anonymized batch to the AMS ingest collector, signed the same way orb-collector.ts signs its
 * own export (a full-length HMAC over the JSON body, distinct from the per-field hmacAnonymize truncated hash
 * above — a body signature and a field anonymization hash are different concerns). Returns `{ sent }` on a 2xx
 * response, `{ sent: 0, error }` otherwise — a network failure or non-2xx never throws, matching this module's
 * fail-open posture (a telemetry hiccup must never break the miner's real work).
 */
export async function sendAmsExportBatch({ batch, secret, collectorUrl = resolveAmsCollectorUrl(), collectorToken, fetchFn = fetch }) {
  if (!Array.isArray(batch) || batch.length === 0) return { sent: 0 };
  const instanceId = amsInstanceId(secret);
  const body = JSON.stringify({ instanceId, events: batch });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  try {
    const res = await fetchFn(collectorUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ams-signature": `sha256=${signature}`,
        "x-ams-instance": instanceId,
        ...(collectorToken ? { authorization: `Bearer ${collectorToken}` } : {}),
      },
      body,
    });
    if (!res.ok) return { sent: 0, error: `http_${res.status}` };
  } catch (error) {
    return { sent: 0, error: describeCliError(error) };
  }
  return { sent: batch.length };
}

const ORB_EXPORT_USAGE = "Usage: loopover-miner orb export [--enable] [--send] [--dry-run] [--json]";

export function parseOrbExportArgs(args) {
  const options = { json: false, enable: false, send: false, dryRun: false };
  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--enable") {
      options.enable = true;
      continue;
    }
    // Distinct from --enable: --enable alone only builds+prints the anonymized batch locally (no network I/O),
    // so a contributor can inspect exactly what would be sent before ever transmitting it. --send additionally
    // POSTs that batch to the collector and advances the cursor — the previously-missing network step (#5681).
    if (token === "--send") {
      options.send = true;
      continue;
    }
    // #4847: openOrbExportStore() itself creates the local SQLite file (a real write) even before any secret is
    // generated, so a dry run reports what would happen and returns before opening any store at all.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    return { error: ORB_EXPORT_USAGE };
  }
  return options;
}

/** CLI entry for the anonymized Orb telemetry batch-builder + sender (#4833 wired the caller-less exporter's
 *  batch-building; #5681 wired the network send). OPT-IN: prints nothing to export unless `--enable` is
 *  passed. `--enable` alone only builds+prints the anonymized batch locally — no network I/O, so a contributor
 *  can inspect exactly what would be sent first. `--enable --send` additionally POSTs the (cursor-filtered)
 *  batch to the AMS collector and advances the cursor on success, so a re-run doesn't resend history that was
 *  already delivered. */
export async function runOrbExportCli(args, options = {}) {
  const parsed = parseOrbExportArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", enabled: parsed.enable, send: parsed.send };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else if (parsed.enable && parsed.send) {
      console.log("DRY RUN: would build an anonymized Orb export batch and send it to the collector. No local writes or network calls were made.");
    } else if (parsed.enable) {
      console.log("DRY RUN: would build and report an anonymized Orb export batch. No local writes were made.");
    } else {
      console.log("DRY RUN: orb export is opt-in and disabled — pass --enable to build an anonymized batch. No local writes were made.");
    }
    return 0;
  }

  // Open the stores INSIDE the try so a bad config path / SQLite open failure returns 2 instead of crashing the
  // process; the finally guards each close with `?.` since either initializer may have thrown before assigning.
  // The --send path's await happens INSIDE this try so `finally` (which closes the store) can never run before
  // the cursor advance below it -- resolving the send result AFTER the store closed would write to a dead handle.
  const ownsStore = options.openOrbExportStore === undefined;
  const ownsLedger = options.initEventLedger === undefined;
  let store;
  let eventLedger;
  try {
    store = (options.openOrbExportStore ?? openOrbExportStore)();
    eventLedger = (options.initEventLedger ?? initEventLedger)();
    const batch = collectOrbExportBatch({ store, eventLedger, enabled: parsed.enable });
    if (batch === null) {
      if (parsed.json) console.log(JSON.stringify({ enabled: false, batch: null }, null, 2));
      else console.log("orb export is opt-in and disabled — pass --enable to build an anonymized batch");
      return 0;
    }

    if (!parsed.send) {
      if (parsed.json) console.log(JSON.stringify({ enabled: true, sent: false, batch }, null, 2));
      else console.log(`${batch.length} anonymized event(s) — pass --send to transmit them to the collector`);
      return 0;
    }

    const cursor = store.getCursor();
    const toSend = filterBatchSinceCursor(batch, cursor);
    if (toSend.length === 0) {
      if (parsed.json) console.log(JSON.stringify({ enabled: true, sent: 0, skipped: batch.length }, null, 2));
      else console.log("no new events since the last export");
      return 0;
    }

    const send = options.sendAmsExportBatch ?? sendAmsExportBatch;
    const secret = store.getOrCreateAnonSecret();
    const env = options.env ?? process.env;
    const collectorToken = env.LOOPOVER_MINER_AMS_COLLECTOR_TOKEN ?? "";
    const sendResult = await send({ batch: toSend, secret, collectorToken });
    if (sendResult.sent > 0) {
      const nextCursor = latestClosedAt(toSend);
      if (nextCursor) store.setCursor(nextCursor);
    }
    if (parsed.json) console.log(JSON.stringify({ enabled: true, ...sendResult, skipped: batch.length - toSend.length }, null, 2));
    else if (sendResult.error) console.log(`export failed: ${sendResult.error}`);
    else console.log(`sent ${sendResult.sent} anonymized event(s)`);
    return sendResult.error ? 1 : 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  } finally {
    if (ownsStore) store?.close();
    if (ownsLedger) eventLedger?.close();
  }
}
