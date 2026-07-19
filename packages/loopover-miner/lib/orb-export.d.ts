import type { NormalizedPrOutcomePayload, PrOutcomeLedgerReader } from "./pr-outcome.js";
/** OPT-IN: a laptop miner exports nothing unless a contributor explicitly turns it on. */
export declare const ORB_EXPORT_ENABLED_BY_DEFAULT: false;
export interface OrbExportRow {
    repoHash: string;
    prHash: string;
    decision: string;
    reasonBucket: string;
    closedAt: string | null;
}
export interface OrbExportStore {
    dbPath: string;
    getOrCreateAnonSecret(): string;
    getCursor(): string | null;
    setCursor(cursor: string): void;
    close(): void;
}
export type AmsExportSendResult = {
    sent: number;
    error?: string;
};
export type OrbExportOutcome = NormalizedPrOutcomePayload & {
    repoFullName: string;
};
export type ParsedOrbExportArgs = {
    json: boolean;
    enable: boolean;
    send: boolean;
    dryRun: boolean;
} | {
    error: string;
};
type RunOrbExportCliOptions = {
    openOrbExportStore?: () => OrbExportStore;
    initEventLedger?: () => PrOutcomeLedgerReader & {
        close(): void;
    };
    sendAmsExportBatch?: (options: {
        batch: OrbExportRow[];
        secret: string;
        collectorToken?: string | undefined;
    }) => Promise<AmsExportSendResult>;
    env?: Record<string, string | undefined>;
};
export declare function resolveOrbExportDbPath(env?: Record<string, string | undefined>): string;
/** HMAC a value with the per-instance secret. Validates the secret (the shared engine primitive stays pure
 *  and doesn't), then delegates the actual hash to @loopover/engine's hmacAnonymize вЂ” the same primitive
 *  src/selfhost/orb-collector.ts uses, so both products anonymize identically. */
export declare function hmacAnonymize(value: string | number, secret: string): string;
/**
 * Turn the local pr_outcome map (pr-outcome.js `readPrOutcomes`) into an anonymized export batch: repo and PR
 * identifiers are HMAC-hashed, and only the `decision` + a low-cardinality `reasonBucket` (already one of the
 * miner's `REJECTION_REASONS`, else `"none"`) + `closedAt` leave. Pure and deterministic (rows sorted by prHash).
 * Accepts either the Map `readPrOutcomes` returns or any iterable of outcome records.
 */
export declare function buildAnonymizedOrbBatch(outcomes: Iterable<OrbExportOutcome> | Map<string, OrbExportOutcome>, secret: string): OrbExportRow[];
/**
 * Open/create the local orb-export store: a small key/value SQLite table holding the per-instance anonymization
 * secret and the export cursor. Mirrors the other miner ledgers' node:sqlite pattern вЂ” a `0o700` config dir and a
 * `0o600` file, since the secret must never leave this machine.
 */
export declare function openOrbExportStore(dbPath?: string): OrbExportStore;
/**
 * Collect the anonymized Orb export batch from the local pr_outcome ledger. OPT-IN: returns null (exports nothing)
 * unless `enabled` is true вЂ” a third-party contributor's laptop must explicitly turn this on. Never performs the
 * network POST itself; the caller sends the returned batch to the Orb ingest endpoint and then advances the store
 * cursor, so this function stays pure over its inputs and the local store.
 */
export declare function collectOrbExportBatch({ store, eventLedger, enabled }?: {
    store?: OrbExportStore;
    eventLedger?: PrOutcomeLedgerReader;
    enabled?: boolean;
}): OrbExportRow[] | null;
/** Stable per-instance identifier: a hash of the instance's own anon secret (no App-id concept on the AMS side,
 *  unlike orb-collector.ts's instanceId вЂ” a miner laptop has no GitHub App). */
export declare function amsInstanceId(secret: string): string;
/** Drop rows already sent in a prior export: everything with a `closedAt` at/before the cursor. A row with no
 *  `closedAt` (shouldn't happen for a resolved PR, but defensive) is always included, since there is no
 *  watermark to compare it against. A null/unset cursor means "first export" вЂ” everything goes. */
export declare function filterBatchSinceCursor(batch: OrbExportRow[], cursor: string | null): OrbExportRow[];
/** The newest `closedAt` among a batch's rows, or `null` if none carry one вЂ” the next cursor value to persist
 *  after a successful send. */
export declare function latestClosedAt(batch: OrbExportRow[]): string | null;
/** loopover's hosted AMS collector вЂ” mirrors orb-collector.ts's ORB_COLLECTOR_URL default pattern. */
export declare const DEFAULT_AMS_COLLECTOR_URL = "https://api.loopover.ai/v1/ams/ingest";
export declare function resolveAmsCollectorUrl(env?: Record<string, string | undefined>): string;
/**
 * POST an already-anonymized batch to the AMS ingest collector, signed the same way orb-collector.ts signs its
 * own export (a full-length HMAC over the JSON body, distinct from the per-field hmacAnonymize truncated hash
 * above вЂ” a body signature and a field anonymization hash are different concerns). Returns `{ sent }` on a 2xx
 * response, `{ sent: 0, error }` otherwise вЂ” a network failure or non-2xx never throws, matching this module's
 * fail-open posture (a telemetry hiccup must never break the miner's real work).
 */
export declare const DEFAULT_ORB_EXPORT_TIMEOUT_MS = 10000;
export declare function sendAmsExportBatch({ batch, secret, collectorUrl, collectorToken, fetchFn, timeoutMs, }: {
    batch: OrbExportRow[];
    secret: string;
    collectorUrl?: string;
    collectorToken?: string | undefined;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}): Promise<AmsExportSendResult>;
export declare function parseOrbExportArgs(args: string[]): ParsedOrbExportArgs;
/** CLI entry for the anonymized Orb telemetry batch-builder + sender (#4833 wired the caller-less exporter's
 *  batch-building; #5681 wired the network send). OPT-IN: prints nothing to export unless `--enable` is
 *  passed. `--enable` alone only builds+prints the anonymized batch locally вЂ” no network I/O, so a contributor
 *  can inspect exactly what would be sent first. `--enable --send` additionally POSTs the (cursor-filtered)
 *  batch to the AMS collector and advances the cursor on success, so a re-run doesn't resend history that was
 *  already delivered. */
export declare function runOrbExportCli(args: string[], options?: RunOrbExportCliOptions): Promise<number>;
export {};
