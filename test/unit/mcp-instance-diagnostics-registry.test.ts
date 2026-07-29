import { afterEach, describe, expect, it } from "vitest";
import {
  getInstanceBackupStatusReader,
  getInstanceDoctorRunner,
  getInstanceLogTailer,
  getInstanceStatusReader,
  resetInstanceDiagnosticsForTesting,
  setInstanceBackupStatusReader,
  setInstanceDoctorRunner,
  setInstanceLogTailer,
  setInstanceStatusReader,
} from "../../src/mcp/instance-diagnostics-registry";

// #9522: the Workers-safe capability registry behind the self-host diagnostics tools. Four INDEPENDENT
// slots, mirroring redeploy-companion-registry.ts: a host that can report status but has no backup volume
// mounted must leave that one slot null and answer "not configured" for that tool alone, not fail all four.

afterEach(() => {
  resetInstanceDiagnosticsForTesting();
});

describe("instance diagnostics registry (#9522)", () => {
  it("starts empty, so an unwired deployment answers 'not configured' rather than throwing", () => {
    expect(getInstanceStatusReader()).toBeNull();
    expect(getInstanceDoctorRunner()).toBeNull();
    expect(getInstanceLogTailer()).toBeNull();
    expect(getInstanceBackupStatusReader()).toBeNull();
  });

  it("round-trips each slot independently — filling one must not fill the others", async () => {
    setInstanceStatusReader(async () => ({ appVersion: "1.2.3" }));
    expect(await getInstanceStatusReader()!()).toEqual({ appVersion: "1.2.3" });
    // The other three are still unset: that is the partial-capability case the split exists for.
    expect(getInstanceDoctorRunner()).toBeNull();
    expect(getInstanceLogTailer()).toBeNull();
    expect(getInstanceBackupStatusReader()).toBeNull();

    setInstanceDoctorRunner(async () => ({ ok: true, checks: [{ name: "db", status: "pass" }] }));
    expect((await getInstanceDoctorRunner()!()).checks[0]!.name).toBe("db");

    setInstanceLogTailer(async ({ lines }) => ({ lines: Array.from({ length: lines }, (_, i) => `line ${i}`), truncated: false }));
    expect((await getInstanceLogTailer()!({ lines: 2 })).lines).toEqual(["line 0", "line 1"]);

    setInstanceBackupStatusReader(async () => ({ lastBackupAt: "2026-07-28T00:00:00.000Z" }));
    expect(await getInstanceBackupStatusReader()!()).toEqual({ lastBackupAt: "2026-07-28T00:00:00.000Z" });
  });

  it("clears a slot back to null, so a capability can be withdrawn", () => {
    setInstanceStatusReader(async () => ({}));
    setInstanceStatusReader(null);
    expect(getInstanceStatusReader()).toBeNull();
  });

  it("resetInstanceDiagnosticsForTesting drops every slot at once", async () => {
    setInstanceStatusReader(async () => ({}));
    setInstanceDoctorRunner(async () => ({ ok: true, checks: [] }));
    setInstanceLogTailer(async () => ({ lines: [], truncated: false }));
    setInstanceBackupStatusReader(async () => ({}));
    resetInstanceDiagnosticsForTesting();
    expect([getInstanceStatusReader(), getInstanceDoctorRunner(), getInstanceLogTailer(), getInstanceBackupStatusReader()]).toEqual([null, null, null, null]);
  });

  it("passes an optional `since` through to the tailer only when given", async () => {
    const seen: unknown[] = [];
    setInstanceLogTailer(async (options) => {
      seen.push(options);
      return { lines: [], truncated: true };
    });
    await getInstanceLogTailer()!({ lines: 10 });
    await getInstanceLogTailer()!({ lines: 10, since: "15m" });
    expect(seen).toEqual([{ lines: 10 }, { lines: 10, since: "15m" }]);
  });
});
