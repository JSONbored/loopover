import { afterEach, describe, expect, it, vi } from "vitest";
import { LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES } from "../../src/db/retention";
import {
  d1DatabaseSizeBytesSample,
  d1SignalSnapshotsRowsPerKeySample,
  d1TableRowCountSamples,
  fetchD1DatabaseInfo,
  fetchD1TableRowCount,
  isD1SizeProbeEnabled,
  resetD1SizeProbeForTest,
  resolveD1SizeProbeConfig,
  runD1SizeProbe,
  type D1SizeProbeConfig,
  type D1SizeProbeEnv,
} from "../../src/selfhost/d1-size-probe";
import { renderMetrics, resetMetrics, gauge, gaugeVector, counterValue } from "../../src/selfhost/metrics";

afterEach(() => {
  vi.restoreAllMocks();
  resetD1SizeProbeForTest();
  resetMetrics();
});

const FULL_ENV: D1SizeProbeEnv = {
  CLOUDFLARE_D1_MONITOR_ACCOUNT_ID: "acct-1",
  CLOUDFLARE_D1_MONITOR_DATABASE_ID: "db-1",
  CLOUDFLARE_D1_MONITOR_API_TOKEN: "token-1",
};

function envelope<T>(result: T): string {
  return JSON.stringify({ success: true, errors: [], result });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** A fetch stub that answers the database-info GET and the per-table query POST generically -- the query
 *  handler inspects the outer table name (the LAST "FROM <word>") so it works for any monitored table
 *  without per-test enumeration, and special-cases signal_snapshots' extra dedup columns. */
function mockFetch(opts: {
  databaseInfo?: () => Response;
  rowsForTable?: (table: string) => { total: number; dedupTotal?: number; dedupDistinctKeys?: number } | null;
  calls?: { url: string; method: string }[];
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    opts.calls?.push({ url, method });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string };
      const table = body.sql.match(/FROM (\w+)\s*$/)?.[1] ?? "unknown";
      const row = opts.rowsForTable?.(table) ?? null;
      if (row === null) return new Response(envelope([{ results: [], success: true, meta: {} }]), { status: 500 });
      const resultRow: Record<string, number> = { total: row.total };
      if (row.dedupTotal !== undefined) resultRow.dedup_total = row.dedupTotal;
      if (row.dedupDistinctKeys !== undefined) resultRow.dedup_distinct_keys = row.dedupDistinctKeys;
      return new Response(envelope([{ results: [resultRow], success: true, meta: {} }]));
    }
    return opts.databaseInfo ? opts.databaseInfo() : new Response(envelope({}), { status: 500 });
  }) as typeof fetch;
}

function okDatabaseInfo(fileSize: number, numTables = 12): () => Response {
  return () => new Response(envelope({ file_size: fileSize, num_tables: numTables }));
}

describe("resolveD1SizeProbeConfig / isD1SizeProbeEnabled", () => {
  it("resolves a config when all three vars are present", () => {
    const config = resolveD1SizeProbeConfig(FULL_ENV);
    expect(config).not.toBeNull();
    expect(config?.accountId).toBe("acct-1");
    expect(config?.databaseId).toBe("db-1");
    expect(config?.apiToken).toBe("token-1");
    expect(config?.tables.length).toBeGreaterThan(0);
    expect(isD1SizeProbeEnabled(FULL_ENV)).toBe(true);
  });

  it("trims the api token before building authorization headers", async () => {
    const config = resolveD1SizeProbeConfig({ ...FULL_ENV, CLOUDFLARE_D1_MONITOR_API_TOKEN: "  token-1  " });
    expect(config).not.toBeNull();
    expect(config?.apiToken).toBe("token-1");

    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
      return new Response(envelope({ file_size: 1, num_tables: 1 }));
    };
    await expect(fetchD1DatabaseInfo(config!, fetchImpl)).resolves.toEqual({ fileSizeBytes: 1, numTables: 1 });
  });

  it("returns null (disabled) when the account id is missing", () => {
    expect(resolveD1SizeProbeConfig({ ...FULL_ENV, CLOUDFLARE_D1_MONITOR_ACCOUNT_ID: undefined })).toBeNull();
  });

  it("returns null (disabled) when the database id is missing", () => {
    expect(resolveD1SizeProbeConfig({ ...FULL_ENV, CLOUDFLARE_D1_MONITOR_DATABASE_ID: undefined })).toBeNull();
  });

  it("returns null (disabled) when the api token is missing", () => {
    expect(resolveD1SizeProbeConfig({ ...FULL_ENV, CLOUDFLARE_D1_MONITOR_API_TOKEN: "" })).toBeNull();
  });

  it("returns null (disabled) when the api token contains a control character", () => {
    expect(resolveD1SizeProbeConfig({ ...FULL_ENV, CLOUDFLARE_D1_MONITOR_API_TOKEN: "token-1\nTAIL" })).toBeNull();
  });

  it("isD1SizeProbeEnabled is false with no config at all", () => {
    expect(isD1SizeProbeEnabled({})).toBe(false);
  });
});

describe("fetchD1DatabaseInfo", () => {
  const config: D1SizeProbeConfig = { accountId: "a", databaseId: "d", apiToken: "t", tables: [] };

  it("parses file_size and num_tables from a successful response", async () => {
    const info = await fetchD1DatabaseInfo(config, mockFetch({ databaseInfo: okDatabaseInfo(3_890_057_216, 9) }));
    expect(info).toEqual({ fileSizeBytes: 3_890_057_216, numTables: 9 });
  });

  it("defaults missing fields to 0", async () => {
    const info = await fetchD1DatabaseInfo(
      config,
      mockFetch({ databaseInfo: () => new Response(envelope({})) }),
    );
    expect(info).toEqual({ fileSizeBytes: 0, numTables: 0 });
  });

  it("throws with the Cloudflare error message on a non-OK response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "Could not route to account" }], result: null }), { status: 403 });
    await expect(fetchD1DatabaseInfo(config, fetchImpl)).rejects.toThrow(/7003: Could not route to account/);
  });

  it("throws a generic HTTP-status error when the body isn't valid JSON", async () => {
    const fetchImpl: typeof fetch = async () => new Response("<html>gateway error</html>", { status: 502 });
    await expect(fetchD1DatabaseInfo(config, fetchImpl)).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the envelope reports success:false even with a 200 status", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ success: false, errors: [], result: null }));
    await expect(fetchD1DatabaseInfo(config, fetchImpl)).rejects.toThrow(/HTTP 200/);
  });
});

describe("fetchD1TableRowCount", () => {
  const config: D1SizeProbeConfig = { accountId: "a", databaseId: "d", apiToken: "t", tables: [] };

  it("rejects an unsafe table identifier before making any request", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response(envelope([{ results: [{ total: 1 }], success: true, meta: {} }]));
    };
    await expect(fetchD1TableRowCount(config, "bad; DROP TABLE x", fetchImpl)).rejects.toThrow(/Unsafe D1 monitored table identifier/);
    expect(called).toBe(false);
  });

  it("reports a plain row count for a non-signal_snapshots table with no dedup field at all", async () => {
    const row = await fetchD1TableRowCount(config, "audit_events", mockFetch({ rowsForTable: () => ({ total: 4242 }) }));
    expect(row).toEqual({ table: "audit_events", rowCount: 4242 });
    expect(row.dedup).toBeUndefined();
  });

  it("reports dedup-scoped row/distinct-key counts for signal_snapshots, binding LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES once each via numbered placeholders", async () => {
    const calls: { url: string; method: string }[] = [];
    let capturedParams: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), method: init?.method ?? "GET" });
      const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params: string[] };
      capturedParams = body.params;
      expect(body.sql).toContain("signal_type IN (?1, ?2, ?3, ?4)");
      return new Response(envelope([{ results: [{ total: 20225, dedup_total: 107, dedup_distinct_keys: 36 }], success: true, meta: {} }]));
    };
    const row = await fetchD1TableRowCount(config, "signal_snapshots", fetchImpl);
    expect(row).toEqual({ table: "signal_snapshots", rowCount: 20225, dedup: { rowCount: 107, distinctKeyCount: 36 } });
    // Each dedup type bound exactly once, matching the SQL's numbered-placeholder reuse (?1 used twice needs
    // only one bound value, mirroring dedupeSignalSnapshots' own ?1 reuse in src/db/retention.ts).
    expect(capturedParams).toEqual([...LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES]);
    expect(calls).toHaveLength(1);
  });

  it("defaults missing result fields to 0", async () => {
    const fetchImpl: typeof fetch = async () => new Response(envelope([{ results: [{}], success: true, meta: {} }]));
    const row = await fetchD1TableRowCount(config, "signal_snapshots", fetchImpl);
    expect(row).toEqual({ table: "signal_snapshots", rowCount: 0, dedup: { rowCount: 0, distinctKeyCount: 0 } });
  });

  it("defaults to an empty row when the query result is missing entirely", async () => {
    const fetchImpl: typeof fetch = async () => new Response(envelope([{ results: [], success: true, meta: {} }]));
    const row = await fetchD1TableRowCount(config, "audit_events", fetchImpl);
    expect(row).toEqual({ table: "audit_events", rowCount: 0 });
    expect(row.dedup).toBeUndefined();
  });
});

describe("runD1SizeProbe", () => {
  it("is a no-op when the probe is not configured (no fetch call at all)", async () => {
    const calls: { url: string; method: string }[] = [];
    await runD1SizeProbe({}, mockFetch({ calls }));
    expect(calls).toHaveLength(0);
    expect(d1DatabaseSizeBytesSample()).toBe(-1);
    expect(d1TableRowCountSamples()).toEqual([]);
  });

  it("populates size and every monitored table's row count on a full success", async () => {
    await runD1SizeProbe(
      FULL_ENV,
      mockFetch({
        databaseInfo: okDatabaseInfo(3_890_057_216),
        rowsForTable: (table) => (table === "signal_snapshots" ? { total: 20225, dedupTotal: 107, dedupDistinctKeys: 36 } : { total: 500 }),
      }),
    );
    expect(d1DatabaseSizeBytesSample()).toBe(3_890_057_216);
    const samples = d1TableRowCountSamples();
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples).toContainEqual({ labels: { table: "signal_snapshots" }, value: 20225 });
    expect(samples).toContainEqual({ labels: { table: "audit_events" }, value: 500 });
    // 107 / 36 ~= 2.972...
    expect(d1SignalSnapshotsRowsPerKeySample()).toBeCloseTo(107 / 36, 6);
  });

  it("keeps the previous sample when a later tick fails entirely, and records the failure", async () => {
    await runD1SizeProbe(FULL_ENV, mockFetch({ databaseInfo: okDatabaseInfo(1_000_000), rowsForTable: () => ({ total: 10 }) }));
    expect(d1DatabaseSizeBytesSample()).toBe(1_000_000);

    const failingFetch: typeof fetch = async () => new Response(envelope(null), { status: 500 });
    await runD1SizeProbe(FULL_ENV, failingFetch);

    expect(d1DatabaseSizeBytesSample()).toBe(1_000_000); // stale, not reset to -1
    expect(d1TableRowCountSamples().length).toBeGreaterThan(0); // stale rows kept, not blanked
    expect(counterValue("gittensory_d1_probe_errors_total", { part: "database_info" })).toBeGreaterThan(0);
    expect(counterValue("gittensory_d1_probe_errors_total", { part: "table_row_count" })).toBeGreaterThan(0);
  });

  it("reads -1 on the very first tick when everything fails (no previous sample to fall back to)", async () => {
    const failingFetch: typeof fetch = async () => new Response(envelope(null), { status: 500 });
    await runD1SizeProbe(FULL_ENV, failingFetch);
    expect(d1DatabaseSizeBytesSample()).toBe(-1);
    expect(d1TableRowCountSamples()).toEqual([]);
  });

  it("redacts the Cloudflare api token from logged probe errors", async () => {
    const secretToken = "cf-secret-token";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingFetch: typeof fetch = async (_input, init) => {
      throw new TypeError(`Headers.append: ${new Headers(init?.headers).get("authorization")} is an invalid header value.`);
    };

    await runD1SizeProbe({ ...FULL_ENV, CLOUDFLARE_D1_MONITOR_API_TOKEN: secretToken }, failingFetch);

    expect(consoleError).toHaveBeenCalled();
    const logged = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain(secretToken);
    expect(logged).toContain("Bearer [redacted]");
  });

  it("isolates a single failing table: other tables still update and the failed one keeps its stale value", async () => {
    await runD1SizeProbe(
      FULL_ENV,
      mockFetch({
        databaseInfo: okDatabaseInfo(1_000_000),
        rowsForTable: (table) => (table === "signal_snapshots" ? { total: 100, dedupTotal: 10, dedupDistinctKeys: 5 } : { total: 1 }),
      }),
    );
    const before = d1TableRowCountSamples().find((s) => s.labels.table === "audit_events");
    expect(before?.value).toBe(1);

    // Second tick: audit_events now errors, everything else (including signal_snapshots) succeeds with new values.
    await runD1SizeProbe(
      FULL_ENV,
      mockFetch({
        databaseInfo: okDatabaseInfo(2_000_000),
        rowsForTable: (table) => {
          if (table === "audit_events") return null; // triggers a 500 in the mock -> throws
          if (table === "signal_snapshots") return { total: 100, dedupTotal: 20, dedupDistinctKeys: 5 };
          return { total: 2 };
        },
      }),
    );

    expect(d1DatabaseSizeBytesSample()).toBe(2_000_000); // unrelated size fetch still updates
    const samples = d1TableRowCountSamples();
    expect(samples).toContainEqual({ labels: { table: "audit_events" }, value: 1 }); // stale, kept from tick 1
    expect(samples).toContainEqual({ labels: { table: "signal_snapshots" }, value: 100 }); // freshly updated
    expect(d1SignalSnapshotsRowsPerKeySample()).toBeCloseTo(20 / 5, 6); // ratio reflects the FRESH sample
    expect(counterValue("gittensory_d1_probe_errors_total", { part: "table_row_count" })).toBeGreaterThan(0);
  });

  it("keeps size at its previous value when only the database-info fetch fails but tables succeed", async () => {
    await runD1SizeProbe(FULL_ENV, mockFetch({ databaseInfo: okDatabaseInfo(5_000_000), rowsForTable: () => ({ total: 1 }) }));
    expect(d1DatabaseSizeBytesSample()).toBe(5_000_000);

    await runD1SizeProbe(
      FULL_ENV,
      mockFetch({ databaseInfo: () => new Response(envelope(null), { status: 500 }), rowsForTable: () => ({ total: 2 }) }),
    );
    expect(d1DatabaseSizeBytesSample()).toBe(5_000_000); // stale, size fetch failed this tick
    expect(d1TableRowCountSamples().every((s) => s.value === 2)).toBe(true); // tables still refreshed
  });
});

describe("d1SignalSnapshotsRowsPerKeySample", () => {
  it("is -1 before any sample has been taken", () => {
    expect(d1SignalSnapshotsRowsPerKeySample()).toBe(-1);
  });

  it("is -1 when signal_snapshots has never been successfully sampled (its fetch keeps failing)", async () => {
    await runD1SizeProbe(
      FULL_ENV,
      mockFetch({ databaseInfo: okDatabaseInfo(1), rowsForTable: (table) => (table === "signal_snapshots" ? null : { total: 1 }) }),
    );
    // signal_snapshots' own fetch failed (mockFetch returns a 500 for a null row) so no dedup sample was ever
    // recorded for it, even though every OTHER monitored table succeeded.
    expect(d1SignalSnapshotsRowsPerKeySample()).toBe(-1);
    expect(d1TableRowCountSamples().some((s) => s.labels.table === "signal_snapshots")).toBe(false);
  });

  it("is -1 when the distinct-key count is 0 (division-by-zero guard)", async () => {
    await runD1SizeProbe(
      FULL_ENV,
      mockFetch({
        databaseInfo: okDatabaseInfo(1),
        rowsForTable: (table) => (table === "signal_snapshots" ? { total: 0, dedupTotal: 0, dedupDistinctKeys: 0 } : { total: 1 }),
      }),
    );
    expect(d1SignalSnapshotsRowsPerKeySample()).toBe(-1);
  });
});

describe("D1 metrics end-to-end via renderMetrics()", () => {
  it("renders gauges and vector series with the registered HELP/TYPE metadata after a successful probe", async () => {
    gauge("gittensory_d1_database_size_bytes", () => d1DatabaseSizeBytesSample());
    gaugeVector("gittensory_d1_table_row_count", () => d1TableRowCountSamples());
    gauge("gittensory_signal_snapshots_rows_per_key", () => d1SignalSnapshotsRowsPerKeySample());

    await runD1SizeProbe(
      FULL_ENV,
      mockFetch({
        databaseInfo: okDatabaseInfo(3_890_057_216),
        rowsForTable: (table) => (table === "signal_snapshots" ? { total: 107, dedupTotal: 107, dedupDistinctKeys: 36 } : { total: 9 }),
      }),
    );

    const out = await renderMetrics();
    expect(out).toContain("# TYPE gittensory_d1_database_size_bytes gauge");
    expect(out).toContain("gittensory_d1_database_size_bytes 3890057216");
    expect(out).toContain("# TYPE gittensory_d1_table_row_count gauge");
    expect(out).toContain('gittensory_d1_table_row_count{table="signal_snapshots"} 107');
    expect(out).toContain("# TYPE gittensory_signal_snapshots_rows_per_key gauge");
    expect(out).toMatch(/gittensory_signal_snapshots_rows_per_key 2\.9\d+/);
  });

  it("renders -1 sentinels and an empty vector before the probe ever runs", async () => {
    gauge("gittensory_d1_database_size_bytes", () => d1DatabaseSizeBytesSample());
    gaugeVector("gittensory_d1_table_row_count", () => d1TableRowCountSamples());
    gauge("gittensory_signal_snapshots_rows_per_key", () => d1SignalSnapshotsRowsPerKeySample());

    const out = await renderMetrics();
    expect(out).toContain("gittensory_d1_database_size_bytes -1");
    expect(out).toContain("gittensory_signal_snapshots_rows_per_key -1");
    expect(out).toContain("# TYPE gittensory_d1_table_row_count gauge");
    expect(out).not.toContain('gittensory_d1_table_row_count{table=');
  });
});
