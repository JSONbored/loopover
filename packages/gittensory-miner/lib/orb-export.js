// Optional anonymized Orb telemetry export for miner PR outcomes (#4277). Mirrors the self-host fleet exporter
// posture in src/selfhost/orb-collector.ts — HMAC-anonymized repo/PR identifiers, bucketed reason codes, signed
// POST to the central collector — but OPT-IN (default OFF) because the miner runs on a contributor laptop with
// no GitHub App key and a higher consent bar than a maintainer's self-hosted instance.
//
//   GITTENSORY_MINER_ORB_EXPORT=1  — explicit opt-in (or config.orbExport === true)
//   ORB_AIR_GAP=true               — air-gapped/offline: compute locally, never send (symmetry with self-host)
//   ORB_ANONYMIZE=true             — HMAC-hash repo/PR before export (default: true)
//   ORB_COLLECTOR_URL=<url>        — endpoint (default: gittensory's hosted collector)
//   ORB_COLLECTOR_TOKEN          — bearer credential for the hosted collector (env var)
//
// Source rows are miner-local {@link MINER_PR_OUTCOME_EVENT} entries from the injected event ledger (the sibling
// pr-outcome.js writer), polled via readEvents({ since }) — the same seq cursor pattern as event-ledger.js. A
// dedicated per-miner anonymization secret is persisted locally (never a GitHub token). No diffs, code, comments,
// logins, or commit SHAs leave the machine.
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MINER_PR_OUTCOME_EVENT, normalizePrOutcomePayload } from "./pr-outcome.js";

const ANON_SECRET_KEY = "orb:anon_secret";
const LAST_EXPORTED_SEQ_KEY = "orb:last_exported_seq";
const DEFAULT_COLLECTOR_URL = "https://gittensory-api.aethereal.dev/v1/orb/ingest";
const defaultDbFileName = "orb-export-state.sqlite3";
let defaultOrbExportStateStore = null;

/** Map the gate's free-text reasonCode to a fixed, low-cardinality category — ported verbatim from
 *  src/selfhost/orb-collector.ts so the fleet shares one taxonomy across self-host and miner exporters. */
export function bucketReasonCode(summary) {
  if (!summary) return "none";
  const s = summary.toLowerCase();
  if (s.includes("linked_issue") || s.includes("linked issue")) return "issue_policy";
  if (s.includes("duplicate")) return "duplicate_risk";
  if (s.includes("slop")) return "slop_advisory";
  if (s.includes("ai_review") || s.includes("ai_consensus") || s.includes("consensus")) return "ai_quality";
  if (s.includes("self_authored") || s.includes("author") || s.includes("maintainer_cut")) return "author_policy";
  if (s.includes("ci_") || s.includes("ci state") || s.includes("ci passed")) return "ci_readiness";
  return "other";
}

/** True when the miner Orb exporter is explicitly enabled and not air-gapped. Default OFF. */
export function isMinerOrbExportEnabled(env = process.env, config = {}) {
  if ((env.ORB_AIR_GAP ?? "").toLowerCase() === "true") return false;
  if (config.orbExport === true) return true;
  return (env.GITTENSORY_MINER_ORB_EXPORT ?? "").trim() === "1";
}

export function resolveOrbExportStateDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_ORB_EXPORT_STATE_DB === "string"
    ? env.GITTENSORY_MINER_ORB_EXPORT_STATE_DB.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolveOrbExportStateDbPath()).trim();
  if (!path) throw new Error("invalid_orb_export_state_db_path");
  return path;
}

function normalizeOptionalSince(since) {
  if (since === undefined || since === null) return 0;
  if (typeof since !== "number" || !Number.isInteger(since) || since < 0) {
    throw new Error("invalid_since");
  }
  return since;
}

/**
 * Local SQLite store for the miner's dedicated anonymization secret and export seq watermark — mirrors
 * getOrCreateAnonSecret's system_flags persistence without requiring D1.
 */
export function initOrbExportStateStore(dbPath = resolveOrbExportStateDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orb_export_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const getStatement = db.prepare("SELECT value FROM orb_export_flags WHERE key = ?");
  const setStatement = db.prepare(`
    INSERT INTO orb_export_flags (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);

  return {
    dbPath: resolvedPath,
    getFlag(key) {
      if (typeof key !== "string" || !key.trim()) throw new Error("invalid_flag_key");
      const row = getStatement.get(key.trim());
      return typeof row?.value === "string" ? row.value : null;
    },
    setFlag(key, value) {
      if (typeof key !== "string" || !key.trim()) throw new Error("invalid_flag_key");
      if (typeof value !== "string" || !value.trim()) throw new Error("invalid_flag_value");
      setStatement.run(key.trim(), value.trim(), new Date().toISOString());
    },
    close() {
      db.close();
    },
  };
}

function getDefaultOrbExportStateStore() {
  defaultOrbExportStateStore ??= initOrbExportStateStore();
  return defaultOrbExportStateStore;
}

export function closeDefaultOrbExportStateStore() {
  if (!defaultOrbExportStateStore) return;
  defaultOrbExportStateStore.close();
  defaultOrbExportStateStore = null;
}

/** Stable miner instance identifier derived from the dedicated anonymization secret (no PII, no GitHub tokens). */
export function minerInstanceId(anonSecret) {
  return createHash("sha256").update(`miner:${anonSecret}`).digest("hex").slice(0, 16);
}

/** HMAC a string with the miner's dedicated anonymization secret. */
export function hmacField(value, secret) {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 24);
}

export function buildTargetId(repoFullName, prNumber) {
  return `${repoFullName}#${prNumber}`;
}

/**
 * The miner's DEDICATED anonymization secret: a 256-bit random key generated once and persisted locally,
 * single-purpose — never a GitHub token (key separation). The collector never holds it.
 */
export function getOrCreateAnonSecret(stateStore) {
  if (!stateStore || typeof stateStore.getFlag !== "function" || typeof stateStore.setFlag !== "function") {
    throw new Error("invalid_orb_export_state_store");
  }
  const existing = stateStore.getFlag(ANON_SECRET_KEY);
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex");
  stateStore.setFlag(ANON_SECRET_KEY, generated);
  return stateStore.getFlag(ANON_SECRET_KEY) ?? generated;
}

export function readLastExportedSeq(stateStore) {
  const raw = stateStore.getFlag(LAST_EXPORTED_SEQ_KEY);
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function writeLastExportedSeq(stateStore, seq) {
  if (!Number.isInteger(seq) || seq < 0) throw new Error("invalid_export_seq");
  stateStore.setFlag(LAST_EXPORTED_SEQ_KEY, String(seq));
}

/** Map one validated pr_outcome ledger entry to the hosted collector's fleet event shape. */
export function ledgerEntryToFleetEvent(entry, options = {}) {
  const secret = options.secret;
  if (typeof secret !== "string" || !secret.trim()) throw new Error("invalid_anon_secret");
  const anonymize = options.anonymize !== false;
  if (typeof entry?.repoFullName !== "string" || !entry.repoFullName.trim()) return null;
  const payload = normalizePrOutcomePayload(entry.payload);
  if (!payload) return null;
  const repoFullName = entry.repoFullName.trim();
  const targetId = buildTargetId(repoFullName, payload.prNumber);
  const outcomeAt = payload.closedAt ?? entry.createdAt ?? new Date().toISOString();
  return {
    repo_hash: anonymize ? hmacField(repoFullName, secret) : repoFullName,
    pr_hash: anonymize ? hmacField(targetId, secret) : targetId,
    gate_verdict: null,
    outcome: payload.decision,
    reversal_flag: "none",
    gate_reasoncode_bucket: bucketReasonCode(payload.reason),
    time_to_close_ms: null,
    decision_timestamp: null,
    outcome_timestamp: outcomeAt,
  };
}

/** Read pr_outcome ledger rows strictly after `since`, preserving seq order, capped at `batchSize`. */
export function selectPrOutcomeEvents(eventLedger, since, batchSize) {
  const normalizedSince = normalizeOptionalSince(since);
  if (!eventLedger || typeof eventLedger.readEvents !== "function") throw new Error("invalid_event_ledger");
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("invalid_batch_size");
  const events = eventLedger.readEvents({ since: normalizedSince });
  const selected = [];
  for (const entry of Array.isArray(events) ? events : []) {
    if (entry?.type !== MINER_PR_OUTCOME_EVENT) continue;
    if (!normalizePrOutcomePayload(entry.payload)) continue;
    selected.push(entry);
    if (selected.length >= batchSize) break;
  }
  return selected;
}

/**
 * Export newly-recorded miner PR outcomes (since the local seq watermark) to the central collector. Opt-in only;
 * returns the number of events exported (0 when disabled, air-gapped, or nothing new).
 */
export async function exportMinerOrbBatch(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  if (!isMinerOrbExportEnabled(env, config)) return 0;
  if ((env.ORB_AIR_GAP ?? "").toLowerCase() === "true") return 0;

  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.readEvents !== "function") throw new Error("invalid_event_ledger");

  const stateStore = options.stateStore ?? getDefaultOrbExportStateStore();
  const fetchFn = options.fetchFn ?? fetch;
  const batchSize = options.batchSize ?? 200;

  const secret = getOrCreateAnonSecret(stateStore);
  const anonymize = (env.ORB_ANONYMIZE ?? "true").toLowerCase() !== "false";
  const instance = minerInstanceId(secret);
  const since = readLastExportedSeq(stateStore);
  const entries = selectPrOutcomeEvents(eventLedger, since, batchSize);
  if (entries.length === 0) return 0;

  const fleetEvents = entries.map((entry) => ledgerEntryToFleetEvent(entry, { secret, anonymize })).filter(Boolean);
  if (fleetEvents.length === 0) return 0;

  const payload = { instance_id: instance, events: fleetEvents };
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const collectorUrl = env.ORB_COLLECTOR_URL ?? DEFAULT_COLLECTOR_URL;
  const collectorToken = env.ORB_COLLECTOR_TOKEN;

  try {
    const res = await fetchFn(collectorUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orb-signature": `sha256=${signature}`,
        "x-orb-instance": instance,
        ...(collectorToken ? { authorization: `Bearer ${collectorToken}` } : {}),
      },
      body,
    });
    if (!res.ok) return 0;
  } catch {
    return 0;
  }

  writeLastExportedSeq(stateStore, entries[entries.length - 1].seq);
  return fleetEvents.length;
}
