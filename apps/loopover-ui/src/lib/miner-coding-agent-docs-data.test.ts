import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CODING_AGENT_DRIVER_NAMES } from "../../../../packages/loopover-engine/src/miner/driver-factory";
import {
  MINER_CODING_AGENT_ENV_ROWS,
  MINER_CODING_AGENT_PROVIDER_ITEMS,
} from "./miner-coding-agent-docs-data";

// Renders from content/docs/miner-coding-agent.mdx via the fumadocs client-loader (see
// docs-source.server.ts's comment) -- a synchronous component render can't exercise that path
// without a full router context, so this is a content drift-guard on the .mdx source, matching
// the pattern in docs-selfhost-activation-paths.test.ts. Moved out of src/routes/ (#8151) once
// docs.miner-coding-agent.tsx (its former sibling) was deleted along with the other 48
// per-page docs.<slug>.tsx route files -- this file tests content data, not routing.
const MDX_PATH = "content/docs/miner-coding-agent.mdx";

describe("miner coding-agent docs content", () => {
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
});
