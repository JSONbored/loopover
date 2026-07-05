import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = join(process.cwd(), "packages/gittensory-miner/README.md");

describe("gittensory-miner claim ledger README (#2291)", () => {
  it("documents the foundation claim ledger API surface", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("openClaimLedger");
    expect(readme).toContain("claimIssue");
    expect(readme).toContain("releaseClaim");
    expect(readme).toContain("listActiveClaims");
    expect(readme).toContain("bookkeeping only");
    expect(readme).toContain("@jsonbored/gittensory-engine");
  });
});
