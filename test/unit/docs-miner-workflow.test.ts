import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MINER_WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.miner-workflow.tsx",
);

describe("docs miner workflow page", () => {
  const source = readFileSync(MINER_WORKFLOW_PATH, "utf8");

  it("cross-links to the miner coding-agent driver page before the loop steps", () => {
    expect(source).toMatch(/Miner coding-agent driver/);
    expect(source).toMatch(/\/docs\/miner-coding-agent/);
  });
});
