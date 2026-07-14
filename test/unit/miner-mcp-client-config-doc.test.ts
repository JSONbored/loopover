import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const README_PATH = join(process.cwd(), "packages/gittensory-miner/README.md");
const MCP_README_PATH = join(process.cwd(), "packages/gittensory-mcp/README.md");

/** Pulls the first ```json fenced block out of a markdown doc. Throws if none is found, so a doc edit that
 *  accidentally drops the fence (rather than its content) fails loudly instead of silently skipping. */
function extractFirstJsonBlock(markdown: string): string {
  const match = markdown.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  if (!match || match[1] === undefined) throw new Error("No ```json fenced block found in the given markdown.");
  return match[1];
}

describe("miner MCP client config example (#5163)", () => {
  it("documents running loopover-mcp and loopover-miner-mcp together", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("### Client config");
    expect(readme).toContain("loopover-mcp init-client --print claude");
    // Explains what each server is for, not just how to wire it up.
    expect(readme).toContain("contributor-workflow tools");
    expect(readme).toContain("state-visibility tools");
  });

  it("ships a copy-pasteable, valid mcpServers JSON snippet registering both servers", () => {
    const readme = readFileSync(README_PATH, "utf8");
    const config = JSON.parse(extractFirstJsonBlock(readme));

    expect(config.mcpServers.gittensory).toEqual({
      command: "loopover-mcp",
      args: ["--stdio"],
    });
    expect(config.mcpServers["loopover-miner"]).toEqual({
      command: "loopover-miner-mcp",
      args: [],
    });
  });

  it("cross-references the ORB MCP README's own Client config section", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("../gittensory-mcp/README.md#client-config");

    const mcpReadme = readFileSync(MCP_README_PATH, "utf8");
    expect(mcpReadme).toContain("### Client config");
  });
});
