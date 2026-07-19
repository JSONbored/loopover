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
// third-party contributor's laptop with a much lower consent bar, so this export is OPT-IN (default OFF) вЂ”
// hence "optional". It mirrors the collector's privacy posture: repo/PR identifiers are HMAC-anonymized with a
// per-instance DEDICATED secret (generated once, persisted locally, single-purpose), and only a fixed
// low-cardinality reason bucket + the decision leave вЂ” never raw repo names or free text. The data source is
// the local pr_outcome ledger (pr-outcome.js), not a hosted D1. `generateAnonSecret`/`hmacAnonymize` are the
// same primitive src/selfhost/orb-collector.ts uses (@loopover/engine, #5680) вЂ” one anonymization
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
 *  and doesn't), then delegates the actual hash to @loopover/engine's hmacAnonymize вЂ” the same primitive
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
    const iterable = outcomes && typeof outcomes.values === "function" ? outcomes.values() : outcomes;
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
 * secret and the export cursor. Mirrors the other miner ledgers' node:sqlite pattern вЂ” a `0o700` config dir and a
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
        /** The per-instance DEDICATED anonymization secret вЂ” generated once (256-bit) and persisted, then reused
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
 * unless `enabled` is true вЂ” a third-party contributor's laptop must explicitly turn this on. Never performs the
 * network POST itself; the caller sends the returned batch to the Orb ingest endpoint and then advances the store
 * cursor, so this function stays pure over its inputs and the local store.
 */
export function collectOrbExportBatch({ store, eventLedger, enabled = ORB_EXPORT_ENABLED_BY_DEFAULT } = {}) {
    if (!enabled)
        return null;
    if (!store || typeof store.getOrCreateAnonSecret !== "function")
        throw new Error("invalid_orb_export_store");
    const outcomes = readPrOutcomes(eventLedger);
    return buildAnonymizedOrbBatch(outcomes, store.getOrCreateAnonSecret());
}
/** Stable per-instance identifier: a hash of the instance's own anon secret (no App-id concept on the AMS side,
 *  unlike orb-collector.ts's instanceId вЂ” a miner laptop has no GitHub App). */
export function amsInstanceId(secret) {
    return createHash("sha256").update(String(secret)).digest("hex").slice(0, 16);
}
/** Drop rows already sent in a prior export: everything with a `closedAt` at/before the cursor. A row with no
 *  `closedAt` (shouldn't happen for a resolved PR, but defensive) is always included, since there is no
 *  watermark to compare it against. A null/unset cursor means "first export" вЂ” everything goes. */
export function filterBatchSinceCursor(batch, cursor) {
    if (!cursor)
        return batch;
    return batch.filter((row) => !row.closedAt || row.closedAt > cursor);
}
/** The newest `closedAt` among a batch's rows, or `null` if none carry one вЂ” the next cursor value to persist
 *  after a successful send. */
export function latestClosedAt(batch) {
    let latest = null;
    for (const row of batch) {
        if (row.closedAt && (latest === null || row.closedAt > latest))
            latest = row.closedAt;
    }
    return latest;
}
/** loopover's hosted AMS collector вЂ” mirrors orb-collector.ts's ORB_COLLECTOR_URL default pattern. */
export const DEFAULT_AMS_COLLECTOR_URL = "https://api.loopover.ai/v1/ams/ingest";
export function resolveAmsCollectorUrl(env = process.env) {
    const explicit = typeof env.LOOPOVER_MINER_AMS_COLLECTOR_URL === "string" ? env.LOOPOVER_MINER_AMS_COLLECTOR_URL.trim() : "";
    return explicit || DEFAULT_AMS_COLLECTOR_URL;
}
/**
 * POST an already-anonymized batch to the AMS ingest collector, signed the same way orb-collector.ts signs its
 * own export (a full-length HMAC over the JSON body, distinct from the per-field hmacAnonymize truncated hash
 * above вЂ” a body signature and a field anonymization hash are different concerns). Returns `{ sent }` on a 2xx
 * response, `{ sent: 0, error }` otherwise вЂ” a network failure or non-2xx never throws, matching this module's
 * fail-open posture (a telemetry hiccup must never break the miner's real work).
 */
// Bound a single AMS-collector POST so a hung/black-holed collector can't stall the export indefinitely (#7237).
// 10s matches this package's other default request timeouts (live-issue-snapshot.js / opportunity-fanout.js).
export const DEFAULT_ORB_EXPORT_TIMEOUT_MS = 10_000;
export async function sendAmsExportBatch({ batch, secret, collectorUrl = resolveAmsCollectorUrl(), collectorToken, fetchFn = fetch, timeoutMs = DEFAULT_ORB_EXPORT_TIMEOUT_MS, }) {
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
        // POSTs that batch to the collector and advances the cursor вЂ” the previously-missing network step (#5681).
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
 *  passed. `--enable` alone only builds+prints the anonymized batch locally вЂ” no network I/O, so a contributor
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
            console.log("DRY RUN: orb export is opt-in and disabled вЂ” pass --enable to build an anonymized batch. No local writes were made.");
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
                console.log("orb export is opt-in and disabled вЂ” pass --enable to build an anonymized batch");
            return 0;
        }
        if (!parsed.send) {
            if (parsed.json)
                console.log(JSON.stringify({ enabled: true, sent: false, batch }, null, 2));
            else
                console.log(`${batch.length} anonymized event(s) вЂ” pass --send to transmit them to the collector`);
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
            eventLedger?.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3JiLWV4cG9ydC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9yYi1leHBvcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDL0MsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNsQyxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUMxQyxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzNDLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQ3JELE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxhQUFhLElBQUksbUJBQW1CLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUM1RixPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFFakQsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ3BELE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVsRiw2R0FBNkc7QUFDN0cseUdBQXlHO0FBQ3pHLDZHQUE2RztBQUM3RywrR0FBK0c7QUFDL0csc0dBQXNHO0FBQ3RHLCtHQUErRztBQUMvRyw2R0FBNkc7QUFDN0csb0dBQW9HO0FBQ3BHLHlGQUF5RjtBQUV6RiwwRkFBMEY7QUFDMUYsTUFBTSxDQUFDLE1BQU0sNkJBQTZCLEdBQUcsS0FBYyxDQUFDO0FBVzVELE1BQU0sZUFBZSxHQUFHLGFBQWEsQ0FBQztBQUN0QyxNQUFNLFVBQVUsR0FBRyxlQUFlLENBQUM7QUFDbkMsTUFBTSxpQkFBaUIsR0FBRyxvQkFBb0IsQ0FBQztBQUUvQyxNQUFNLFVBQVUsc0JBQXNCLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7SUFDMUYsTUFBTSxZQUFZLEdBQ2hCLE9B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