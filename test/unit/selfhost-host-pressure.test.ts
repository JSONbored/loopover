import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  loadavg: vi.fn(),
  cpus: vi.fn(),
}));

describe("hostLoadAvg1PerCore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("normalizes the 1-minute load average by logical core count", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([4, 3, 2]);
    vi.mocked(os.cpus).mockReturnValue(Array.from({ length: 4 }, () => ({}) as never));
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBe(1);
  });

  it("returns null when loadavg() reports no samples at all (empty array)", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([]);
    vi.mocked(os.cpus).mockReturnValue(Array.from({ length: 4 }, () => ({}) as never));
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBeNull();
  });

  it("returns null when load1 is not finite", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([Number.NaN, 0, 0]);
    vi.mocked(os.cpus).mockReturnValue(Array.from({ length: 4 }, () => ({}) as never));
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBeNull();
  });

  it("returns null when load1 is negative", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([-1, 0, 0]);
    vi.mocked(os.cpus).mockReturnValue(Array.from({ length: 4 }, () => ({}) as never));
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBeNull();
  });

  it("returns null when cpus() reports zero cores", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([1, 1, 1]);
    vi.mocked(os.cpus).mockReturnValue([]);
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBeNull();
  });

  it("returns 0 on Windows-style always-zero loadavg (a legitimate reading, not unavailable)", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([0, 0, 0]);
    vi.mocked(os.cpus).mockReturnValue(Array.from({ length: 8 }, () => ({}) as never));
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBe(0);
  });

  it("returns null when loadavg() throws", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockImplementation(() => {
      throw new Error("unsupported platform");
    });
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBeNull();
  });

  it("returns null when cpus() throws", async () => {
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([1, 1, 1]);
    vi.mocked(os.cpus).mockImplementation(() => {
      throw new Error("unsupported platform");
    });
    const { hostLoadAvg1PerCore } = await import("../../src/selfhost/host-pressure");
    expect(hostLoadAvg1PerCore()).toBeNull();
  });
});
