import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  loadavg: vi.fn(),
  cpus: vi.fn(),
  totalmem: vi.fn(),
  freemem: vi.fn(),
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

// #9487: host pressure watched CPU only. On the box this was found on — Ollama resident at ~9.9 GiB
// alongside browserless at ~1.5 GiB — memory is the realistic killer, and nothing observed it: the OOM
// killer made the call instead, taking the whole container and every in-flight job with it rather than
// deferring one maintenance job.
describe("hostMemoryUsedFraction (#9487)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const withMemory = async (total: number, free: number) => {
    const os = await import("node:os");
    vi.mocked(os.totalmem).mockReturnValue(total);
    vi.mocked(os.freemem).mockReturnValue(free);
    const { hostMemoryUsedFraction } = await import("../../src/selfhost/host-pressure");
    return hostMemoryUsedFraction();
  };

  it("reports the used fraction of host memory", async () => {
    expect(await withMemory(16_000_000_000, 4_000_000_000)).toBeCloseTo(0.75, 5);
    expect(await withMemory(16_000_000_000, 16_000_000_000)).toBe(0);
    expect(await withMemory(16_000_000_000, 0)).toBe(1);
  });

  it("INVARIANT: an impossible reading yields null (signal unavailable), never a misleading 0", async () => {
    // Fail-open, same contract as hostLoadAvg1PerCore: a caller treats null as "skip this check". Clamping
    // instead would let a broken platform reading masquerade as "no pressure", which is the one answer that
    // must never be fabricated.
    expect(await withMemory(0, 0)).toBeNull(); // no total
    expect(await withMemory(Number.NaN, 1)).toBeNull();
    expect(await withMemory(16_000_000_000, Number.NaN)).toBeNull();
    expect(await withMemory(16_000_000_000, -1)).toBeNull();
    expect(await withMemory(16_000_000_000, 32_000_000_000)).toBeNull(); // free > total ⇒ ratio out of range
  });

  it("INVARIANT: a throwing os reading degrades to null rather than propagating", async () => {
    const os = await import("node:os");
    vi.mocked(os.totalmem).mockImplementation(() => {
      throw new Error("platform boom");
    });
    const { hostMemoryUsedFraction } = await import("../../src/selfhost/host-pressure");
    expect(hostMemoryUsedFraction()).toBeNull();
  });
});
