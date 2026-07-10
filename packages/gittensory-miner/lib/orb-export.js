import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { readPrOutcomes } from "./pr-outcome.js";

// Optional anonymized Orb telemetry export (#4277). The self-host Orb collector (src/selfhost/orb-collector.ts,
// #1255) is ALWAYS-ON for a maintainer's own instance; a miner runs on a third-party contributor's laptop with a
// much lower consent bar, so this export is OPT-IN (default OFF) — hence "optional". It mirrors the collector's
// privacy posture: repo/PR identifiers are HMAC-anonymized with a per-instance DEDICATED secret (generated once,
// persisted locally, single-purpose), and only a fixed low-cardinality reason bucket + the decision leave — never
// raw repo names or free text. The data source is the local pr_outcome ledger (pr-outcome.js), not a hosted D1.
// This module builds the anonymized batch and manages the local secret + cursor; performing the network POST is the
// caller's job, so this stays pure over its inputs + local store and needs no network to test.

/** OPT-IN: a laptop miner exports nothing unless a contributor explicitly turns it on. */
export const ORB_EXPORT_ENABLED_BY_DEFAULT = false;

const ANON_SECRET_KEY = "anon_secret";
const CURSOR_KEY = "export_cursor";
const defaultDbFileName = "orb-export.sqlite3";

export function resolveOrbExportDbPath(env = process.env) {
  const explicitPath =
    typeof env.GITTENSORY_MINER_ORB_EXPORT_DB === "string" ? env.GITTENSORY_MINER_ORB_EXPORT_DB.trim() : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir =
    typeof env.GITTENSORY_MINER_CONFIG_DIR === "string" ? env.GITTENSORY_MINER_CONFIG_DIR.trim() : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
      ? env.XDG_CONFIG_HOME.trim()
      : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolveOrbExportDbPath()).trim();
  if (!path) throw new Error("invalid_orb_export_db_path");
  return path;
}

/** HMAC a value with the per-instance secret — mirrors orb-collector.ts's hmacField (sha256, first 24 hex). */
export function hmacAnonymize(value, secret) {
  if (typeof secret !== "string" || !secret) throw new Error("invalid_anon_secret");
  return createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, 24);
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
      const generated = randomBytes(32).toString("hex");
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
