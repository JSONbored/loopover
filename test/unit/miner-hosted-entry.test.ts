// Tests for the AMS hosted-container entry point (#7182). runDiscover/runManagePoll/runAttempt and the
// health server are all mocked -- no real GitHub calls, no real HTTP listener bound.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HealthServerOptions = { port: number; probes: Array<{ name: string; check: () => Promise<boolean> }> };

const runDiscover = vi.fn(async (_args: string[]) => 0);
const runManagePoll = vi.fn(async (_args: string[]) => 0);
const runAttempt = vi.fn(async (_args: string[]) => 0);
const startAmsHealthServer = vi.fn(async (_options: HealthServerOptions) => ({ close: (cb: () => void) => cb() }));
const resolveTenantSecret = vi.fn(async (_env: Record<string, string | undefined>) => null as { secretValue: string; secretType: string } | null);

vi.mock("../../packages/loopover-miner/lib/discover-cli.js", () => ({ runDiscover }));
vi.mock("../../packages/loopover-miner/lib/manage-poll.js", () => ({ runManagePoll }));
vi.mock("../../packages/loopover-miner/lib/attempt-cli.js", () => ({ runAttempt }));
vi.mock("../../packages/loopover-miner/lib/ams-health-server.js", () => ({ startAmsHealthServer }));
vi.mock("../../packages/loopover-miner/lib/tenant-credential-resolution.js", () => ({ resolveTenantSecret }));

const { isHostedCycleCommand, runHostedEntry } = await import("../../packages/loopover-miner/lib/hosted-entry");

let stateDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = mkdtempSync(join(tmpdir(), "loopover-miner-hosted-entry-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("isHostedCycleCommand (#7182)", () => {
  it("recognizes exactly the three one-shot cycle commands", () => {
    expect(isHostedCycleCommand("discover")).toBe(true);
    expect(isHostedCycleCommand("manage-poll")).toBe(true);
    expect(isHostedCycleCommand("attempt")).toBe(true);
  });

  it("rejects the continuous self-scheduling `loop` command and anything unknown", () => {
    expect(isHostedCycleCommand("loop")).toBe(false);
    expect(isHostedCycleCommand("status")).toBe(false);
    expect(isHostedCycleCommand("")).toBe(false);
  });
});

describe("runHostedEntry (#7182)", () => {
  it("returns 2 and never starts the health server when no cycle name is given", async () => {
    const exitCode = await runHostedEntry([], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(2);
    expect(startAmsHealthServer).not.toHaveBeenCalled();
  });

  it("returns 2 and never starts the health server for an unknown cycle name", async () => {
    const exitCode = await runHostedEntry(["loop"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(2);
    expect(startAmsHealthServer).not.toHaveBeenCalled();
  });

  it("dispatches 'discover' to runDiscover, forwarding the remaining args, and returns its exit code", async () => {
    runDiscover.mockResolvedValueOnce(0);

    const exitCode = await runHostedEntry(["discover", "--search", "label:good-first-issue"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(0);
    expect(runDiscover).toHaveBeenCalledWith(["--search", "label:good-first-issue"]);
  });

  it("dispatches 'manage-poll' to runManagePoll, forwarding the remaining args", async () => {
    await runHostedEntry(["manage-poll", "acme/widgets", "42", "--json"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(runManagePoll).toHaveBeenCalledWith(["acme/widgets", "42", "--json"]);
  });

  it("dispatches 'attempt' to runAttempt, forwarding the remaining args", async () => {
    await runHostedEntry(["attempt", "some-item-id"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(runAttempt).toHaveBeenCalledWith(["some-item-id"]);
  });

  it("propagates the underlying cycle command's real failure exit code (2)", async () => {
    runDiscover.mockResolvedValueOnce(2);

    const exitCode = await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(2);
  });

  it("starts the health server on the given port with a state-dir readiness probe", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir }, port: 9090 });

    expect(startAmsHealthServer).toHaveBeenCalledTimes(1);
    const call = startAmsHealthServer.mock.calls[0]![0];
    expect(call.port).toBe(9090);
    expect(call.probes).toHaveLength(1);
    expect(call.probes[0]?.name).toBe("state_dir");
  });

  it("defaults the health server port to 8080 when not given", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(startAmsHealthServer.mock.calls[0]![0].port).toBe(8080);
  });

  it("the state_dir probe passes when the resolved state directory exists", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    const call = startAmsHealthServer.mock.calls[0]![0];
    await expect(call.probes[0]!.check()).resolves.toBe(true);
  });

  it("the state_dir probe fails when the resolved state directory does not exist", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: join(stateDir, "does-not-exist") } });

    const call = startAmsHealthServer.mock.calls[0]![0];
    await expect(call.probes[0]!.check()).resolves.toBe(false);
  });

  it("closes the health server even when the cycle command throws, and still propagates the error", async () => {
    const close = vi.fn((cb: () => void) => cb());
    startAmsHealthServer.mockResolvedValueOnce({ close } as never);
    runDiscover.mockRejectedValueOnce(new Error("boom"));

    await expect(runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } })).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("propagates a health-server startup failure without crashing on the never-assigned server", async () => {
    startAmsHealthServer.mockRejectedValueOnce(new Error("port already in use"));

    await expect(runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } })).rejects.toThrow("port already in use");
    expect(runDiscover).not.toHaveBeenCalled();
  });

  it("defaults env to process.env when no override is passed", async () => {
    const exitCode = await runHostedEntry(["discover"]);
    expect(typeof exitCode).toBe("number");
  });

  // #8246: resolveTenantSecret is called once per wake, with whatever env was resolved -- proves the #8202
  // bootstrap-secret mechanism is wired for AMS. It's best-effort by design (see tenant-secret-resolution.ts),
  // so neither a null nor a real result should ever change whether/how the cycle command itself dispatches.
  describe("tenant secret resolution (#8246)", () => {
    it("calls resolveTenantSecret with the resolved env before dispatching the cycle command", async () => {
      const env = { LOOPOVER_MINER_CONFIG_DIR: stateDir, LOOPOVER_TENANT_SECRET_TOKEN: "orbsec_x" };

      await runHostedEntry(["discover"], { env });

      expect(resolveTenantSecret).toHaveBeenCalledExactlyOnceWith(env);
    });

    it("still dispatches normally when no tenant secret resolves (self-host/unprovisioned -- the common case)", async () => {
      resolveTenantSecret.mockResolvedValueOnce(null);

      const exitCode = await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

      expect(exitCode).toBe(0);
      expect(runDiscover).toHaveBeenCalledWith([]);
    });

    it("still dispatches normally when a real tenant secret resolves", async () => {
      resolveTenantSecret.mockResolvedValueOnce({ secretValue: "postgres://tenant-acme@neon/acme", secretType: "tenant_db_credential" });

      const exitCode = await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

      expect(exitCode).toBe(0);
      expect(runDiscover).toHaveBeenCalledWith([]);
    });

    it("logs the resolved secretType when a tenant secret resolves", async () => {
      resolveTenantSecret.mockResolvedValueOnce({ secretValue: "postgres://tenant-acme@neon/acme", secretType: "tenant_db_credential" });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

      const entry = log.mock.calls.map((call) => JSON.parse(call[0] as string) as { event?: string }).find((parsed) => parsed.event === "ams_hosted_entry_tenant_secret_resolved");
      expect(entry).toEqual({ event: "ams_hosted_entry_tenant_secret_resolved", resolved: true, secretType: "tenant_db_credential" });
      log.mockRestore();
    });

    it("logs a null secretType when no tenant secret resolves", async () => {
      resolveTenantSecret.mockResolvedValueOnce(null);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

      const entry = log.mock.calls.map((call) => JSON.parse(call[0] as string) as { event?: string }).find((parsed) => parsed.event === "ams_hosted_entry_tenant_secret_resolved");
      expect(entry).toEqual({ event: "ams_hosted_entry_tenant_secret_resolved", resolved: false, secretType: null });
      log.mockRestore();
    });

    it("never calls resolveTenantSecret for an unknown cycle name (the early-return path)", async () => {
      await runHostedEntry(["loop"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

      expect(resolveTenantSecret).not.toHaveBeenCalled();
    });
  });
});
