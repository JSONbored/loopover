import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CONFIG = "apps/gittensory-ui/src/routes/docs.self-hosting-configuration.tsx";

describe("self-host configuration docs: reviewRecap (#1963)", () => {
  const source = readFileSync(CONFIG, "utf8");

  it("documents the opt-in reviewRecap block and scheduled sweep cadence", () => {
    expect(source).toContain("reviewRecap");
    expect(source).toContain("enabled:");
    expect(source).toContain("cadenceDays:");
    expect(source).toMatch(/10:00 UTC/);
    expect(source).toMatch(/Disabled by default|disabled by default/i);
  });
});
