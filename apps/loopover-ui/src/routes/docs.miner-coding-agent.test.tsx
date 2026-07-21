import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CODING_AGENT_DRIVER_NAMES } from "../../../../packages/loopover-engine/src/miner/driver-factory";
import {
  MINER_CODING_AGENT_ENV_ROWS,
  MINER_CODING_AGENT_PROVIDER_ITEMS,
  MinerCodingAgentDriverDocs,
} from "./docs.miner-coding-agent";

// Renders from content/docs/miner-coding-agent.mdx via the fumadocs client-loader (see
// docs-source.server.ts's comment) -- a synchronous component render can't exercise that path
// without a full router context, so this is now a content drift-guard on the .mdx source,
// matching the pattern in docs-selfhost-activation-paths.test.ts.
const MDX_PATH = "content/docs/miner-coding-agent.mdx";

describe("miner coding-agent docs page", () => {
  it("documents the expected sections", () => {
    const source = readFileSync(MDX_PATH, "utf8");
    expect(source).toContain("title: Miner coding-agent driver");
    expect(source).toContain("## Provider selection");
    expect(source).toContain("## Model and timeout overrides");
    expect(source).toContain("## Recognizing a stale or missing credential");
    expect(source).toContain("## Related docs");
  });

  it("keeps the provider list aligned with the engine's accepted provider names", () => {
    expect(MINER_CODING_AGENT_PROVIDER_ITEMS.map((item) => item.title)).toEqual([
      ...CODING_AGENT_DRIVER_NAMES,
    ]);
  });

  it("documents every driver env var the page claims to cover", () => {
    expect(MINER_CODING_AGENT_ENV_ROWS.map((row) => row.name)).toEqual([
      "MINER_CODING_AGENT_PROVIDER",
      "MINER_CODING_AGENT_CLAUDE_MODEL",
      "MINER_CODING_AGENT_CODEX_MODEL",
      "MINER_CODING_AGENT_TIMEOUT_MS",
    ]);
  });

  it("exports the route component used by the route definition", () => {
    expect(typeof MinerCodingAgentDriverDocs).toBe("function");
  });
});
