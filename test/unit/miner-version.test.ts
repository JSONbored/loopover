import { describe, expect, it } from "vitest";
import {
  MINER_PACKAGE_VERSION,
  resolveMinerVersion,
} from "../../packages/gittensory-miner/lib/version.js";

describe("gittensory-miner version resolution (#4310)", () => {
  it("defaults to the package.json semver when LOOPOVER_MINER_VERSION is unset", () => {
    expect(MINER_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resolveMinerVersion({})).toBe(MINER_PACKAGE_VERSION);
    expect(resolveMinerVersion({ LOOPOVER_MINER_VERSION: "" })).toBe(MINER_PACKAGE_VERSION);
    expect(resolveMinerVersion({ LOOPOVER_MINER_VERSION: "   " })).toBe(MINER_PACKAGE_VERSION);
  });

  it("prefers a nonblank LOOPOVER_MINER_VERSION override (fleet Docker build ref)", () => {
    expect(
      resolveMinerVersion({ LOOPOVER_MINER_VERSION: "gittensory-miner-fleet@abc1234" }),
    ).toBe("gittensory-miner-fleet@abc1234");
    expect(
      resolveMinerVersion({ LOOPOVER_MINER_VERSION: " 0.9.0-beta.1 " }),
    ).toBe("0.9.0-beta.1");
  });
});
