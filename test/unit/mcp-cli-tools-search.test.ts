import { describe, expect, it } from "vitest";

import { run, runExpectingFailure } from "./support/mcp-cli-harness";

// #6300: `tools search <query>` lets a user or agent find the right tool among the ~150-tool combined
// surface without reading the full `tools` listing or already knowing the exact name. It fuzzy-matches the
// query against each registered tool's name AND description, so a term that only appears in a description
// still surfaces the tool.
type SearchPayload = {
  query: string;
  count: number;
  tools: Array<{ name: string; description: string }>;
};

function search(query: string): SearchPayload {
  return JSON.parse(run(["tools", "search", query, "--json"])) as SearchPayload;
}

describe("loopover-mcp CLI — tools search (#6300)", () => {
  it("matches by name and ranks the name hit first", () => {
    const payload = search("reviewability");
    expect(payload.query).toBe("reviewability");
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.tools).toHaveLength(payload.count);
    // A tool whose NAME contains the query is the closest possible match, so it sorts to the top.
    expect(payload.tools[0]!.name).toBe("loopover_get_pr_reviewability");
    expect(payload.tools[0]!.name).toContain("reviewability");
  });

  it("matches by description even when the query is absent from every tool name", () => {
    const payload = search("duplicate");
    expect(payload.count).toBeGreaterThan(0);
    // No registered tool has "duplicate" in its name, so every hit here is description-driven.
    expect(payload.tools.every((tool) => !tool.name.includes("duplicate"))).toBe(true);
    const preflight = payload.tools.find((tool) => tool.name === "loopover_preflight_pr");
    expect(preflight, "a description-only match must still surface").toBeTruthy();
    expect(preflight!.description).toContain("duplicate");
  });

  it("tolerates a typo via the CLI's existing Levenshtein matcher", () => {
    const payload = search("reviewabilty");
    expect(payload.count).toBeGreaterThan(0);
    const hit = payload.tools.find((tool) => tool.name === "loopover_get_pr_reviewability");
    expect(hit, "a one-character typo should still surface the tool").toBeTruthy();
    // The raw (misspelled) query is a substring of neither the name nor the description — this hit can only
    // come from the fuzzy token comparison, not a substring match.
    expect(hit!.name.includes("reviewabilty")).toBe(false);
    expect(hit!.description.toLowerCase().includes("reviewabilty")).toBe(false);
  });

  it("returns an empty result set for a query that matches nothing", () => {
    const payload = search("zzqqxxnope");
    expect(payload.count).toBe(0);
    expect(payload.tools).toEqual([]);
  });

  it("prints name + description rows for a human search and a friendly line when nothing matches", () => {
    const plain = run(["tools", "search", "reviewability"]);
    const payload = search("reviewability");
    for (const tool of payload.tools) {
      expect(plain).toContain(tool.name);
      expect(plain).toContain(tool.description);
    }

    const empty = run(["tools", "search", "zzqqxxnope"]);
    expect(empty).toContain('No tools match "zzqqxxnope".');
  });

  it("rejects a search with no query and documents the subcommand in --help", () => {
    const failure = runExpectingFailure(["tools", "search"]);
    expect(failure.status).not.toBe(0);
    expect(`${failure.stdout}${failure.stderr}`).toContain("Usage: loopover-mcp tools search <query> [--json]");

    const help = run(["--help"]);
    expect(help).toContain("loopover-mcp tools search <query> [--json]");
  });
});
