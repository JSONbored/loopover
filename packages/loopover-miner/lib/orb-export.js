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
    const explicitPath = typeof env.LOOPOVER_MINER_ORB_EXPORT_DB === "string" ? env.LOOPOVER_MINER_ORB_EXPORT_DB.trim() : "";
    if (explicitPath)
        return explicitPath;
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string" ? env.LOOPOVER_MINER_CONFIG_DIR.trim() : "";
    if (explicitConfigDir)
        return join(explicitConfigDir, defaultDbFileName);
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner", defaultDbFileName);
}
function normalizeDbPath(dbPath) {
    const path = (dbPath ?? resolveOrbExportDbPath()).trim();
    if (!path)
        throw new Error("invalid_orb_export_db_path");
    return path;
}
/** HMAC a value with the per-instance secret. Validates the secret (the shared engine primitive stays pure
 *  and doesn't), then delegates the actual hash to @loopover/engine's hmacAnonymize — the same primitive
 *  src/selfhost/orb-collector.ts uses, so both products anonymize identically. */
export function hmacAnonymize(value, secret) {
    if (typeof secret !== "string" || !secret)
        throw new Error("invalid_anon_secret");
    return engineHmacAnonymize(String(value), secret);
}
/**
 * Turn the local pr_outcome map (pr-outcome.js `readPrOutcomes`) into an anonymized export batch: repo and PR
 * identifiers are HMAC-hashed, and only the `decision` + a low-cardinality `reasonBucket` (already one of the
 * miner's `REJECTION_REASONS`, else `"none"`) + `closedAt` leave. Pure and deterministic (rows sorted by prHash).
 * Accepts either the Map `readPrOutcomes` returns or any iterable of outcome records.
 */
export function buildAnonymizedOrbBatch(outcomes, secret) {
    const iterable = outcomes && typeof outcomes.values === "function"
        ? outcomes.values()
        : outcomes;
    const rows = [];
    for (const outcome of iterable ?? []) {
        if (!outcome || typeof outcome.repoFullName !== "string" || !outcome.repoFullName.trim())
            continue;
        if (!Number.isInteger(outcome.prNumber) || outcome.prNumber <= 0)
            continue;
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
    const setStatement = db.prepare("INSERT INTO orb_export_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
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
            if (existing)
                return existing;
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
export function collectOrbExportBatch(options = {}) {
    const { store, eventLedger, enabled = ORB_EXPORT_ENABLED_BY_DEFAULT } = options;
    if (!enabled)
        return null;
    if (!store || typeof store.getOrCreateAnonSecret !== "function")
        throw new Error("invalid_orb_export_store");
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
    if (!cursor)
        return batch;
    return batch.filter((row) => !row.closedAt || row.closedAt > cursor);
}
/** The newest `closedAt` among a batch's rows, or `null` if none carry one — the next cursor value to persist
 *  after a successful send. */
export function latestClosedAt(batch) {
    let latest = null;
    for (const row of batch) {
        if (row.closedAt && (latest === null || row.closedAt > latest))
            latest = row.closedAt;
    }
    return latest;
}
/** loopover's hosted AMS collector — mirrors orb-collector.ts's ORB_COLLECTOR_URL default pattern. */
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
// Bound a single AMS-collector POST so a hung/black-holed collector can't stall the export indefinitely (#7237).
// 10s matches this package's other default request timeouts (live-issue-snapshot.js / opportunity-fanout.js).
export const DEFAULT_ORB_EXPORT_TIMEOUT_MS = 10_000;
export async function sendAmsExportBatch(options) {
    const { batch, secret, collectorUrl = resolveAmsCollectorUrl(), collectorToken, fetchFn = fetch, timeoutMs = DEFAULT_ORB_EXPORT_TIMEOUT_MS, } = options;
    if (!Array.isArray(batch) || batch.length === 0)
        return { sent: 0 };
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
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
            return { sent: 0, error: `http_${res.status}` };
    }
    catch (error) {
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
        }
        else if (parsed.enable && parsed.send) {
            console.log("DRY RUN: would build an anonymized Orb export batch and send it to the collector. No local writes or network calls were made.");
        }
        else if (parsed.enable) {
            console.log("DRY RUN: would build and report an anonymized Orb export batch. No local writes were made.");
        }
        else {
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
            if (parsed.json)
                console.log(JSON.stringify({ enabled: false, batch: null }, null, 2));
            else
                console.log("orb export is opt-in and disabled — pass --enable to build an anonymized batch");
            return 0;
        }
        if (!parsed.send) {
            if (parsed.json)
                console.log(JSON.stringify({ enabled: true, sent: false, batch }, null, 2));
            else
                console.log(`${batch.length} anonymized event(s) — pass --send to transmit them to the collector`);
            return 0;
        }
        const cursor = store.getCursor();
        const toSend = filterBatchSinceCursor(batch, cursor);
        if (toSend.length === 0) {
            if (parsed.json)
                console.log(JSON.stringify({ enabled: true, sent: 0, skipped: batch.length }, null, 2));
            else
                console.log("no new events since the last export");
            return 0;
        }
        const send = options.sendAmsExportBatch ?? sendAmsExportBatch;
        const secret = store.getOrCreateAnonSecret();
        const env = options.env ?? process.env;
        const collectorToken = env.LOOPOVER_MINER_AMS_COLLECTOR_TOKEN ?? "";
        const sendResult = await send({ batch: toSend, secret, collectorToken });
        if (sendResult.sent > 0) {
            const nextCursor = latestClosedAt(toSend);
            if (nextCursor)
                store.setCursor(nextCursor);
        }
        if (parsed.json)
            console.log(JSON.stringify({ enabled: true, ...sendResult, skipped: batch.length - toSend.length }, null, 2));
        else if (sendResult.error)
            console.log(`export failed: ${sendResult.error}`);
        else
            console.log(`sent ${sendResult.sent} anonymized event(s)`);
        return sendResult.error ? 1 : 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsStore)
            store?.close();
        if (ownsLedger)
            eventLedger?.close?.();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3JiLWV4cG9ydC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9yYi1leHBvcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDL0MsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNsQyxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUMxQyxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzNDLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQ3JELE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxhQUFhLElBQUksbUJBQW1CLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUM1RixPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFFakQsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ3BELE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVsRiw2R0FBNkc7QUFDN0cseUdBQXlHO0FBQ3pHLDJHQUEyRztBQUMzRywrR0FBK0c7QUFDL0csc0dBQXNHO0FBQ3RHLDZHQUE2RztBQUM3Ryw2R0FBNkc7QUFDN0csa0dBQWtHO0FBQ2xHLHlGQUF5RjtBQUV6RiwwRkFBMEY7QUFDMUYsTUFBTSxDQUFDLE1BQU0sNkJBQTZCLEdBQUcsS0FBYyxDQUFDO0FBaUM1RCxNQUFNLGVBQWUsR0FBRyxhQUFhLENBQUM7QUFDdEMsTUFBTSxVQUFVLEdBQUcsZUFBZSxDQUFDO0FBQ25DLE1BQU0saUJBQWlCLEdBQUcsb0JBQW9CLENBQUM7QUFFL0MsTUFBTSxVQUFVLHNCQUFzQixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQzFGLE1BQU0sWUFBWSxHQUNoQixP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