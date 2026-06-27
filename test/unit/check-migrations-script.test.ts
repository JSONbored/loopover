import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("check-migrations script", () => {
  it("reports every grandfathered duplicate migration number in the success summary", () => {
    const output = execFileSync(process.execPath, ["scripts/check-migrations.mjs"], { encoding: "utf8" });

    expect(output).toContain("(3 grandfathered duplicates: 0015, 0017, 0074)");
  });
});
