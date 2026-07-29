import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_HOSTS, CONNECTION_MODES, CONNECTION_MODE_SPEC, clientConfigSnippet, supportsConnectionMode } from "@loopover/contract/client-config";
import { docsSection, minerReadmeSection, replaceBetweenMarkers, stdioReadmeSection } from "../../scripts/gen-mcp-client-config";

// #9526: the client-config generator. The point of generating these blocks is that the docs and the CLI can
// no longer disagree, so the assertions here are about that property -- every snippet the docs show is
// byte-identical to one the grid produces -- rather than about the prose around them.

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("the generated docs page (#9526)", () => {
  const section = docsSection();

  it.each(CONNECTION_MODES)("gives %s its own section with its summary and notes", (mode) => {
    const spec = CONNECTION_MODE_SPEC[mode];
    expect(section).toContain(`## ${spec.title}`);
    expect(section).toContain(spec.summary);
    for (const note of spec.notes) expect(section).toContain(note);
  });

  it("shows every supported host/mode pair's snippet VERBATIM", () => {
    for (const mode of CONNECTION_MODES) {
      for (const host of CLIENT_HOSTS.filter((candidate) => supportsConnectionMode(candidate, mode))) {
        // Escaped exactly as the MDX template literal needs; anything else renders as broken JSX.
        const escaped = clientConfigSnippet(host, mode).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
        expect(section, `${host}/${mode} must appear as the grid produces it`).toContain(escaped);
      }
    }
  });

  it("escapes the `${VAR}` in a remote snippet so MDX does not interpolate it away", () => {
    // Unescaped, MDX evaluates ${LOOPOVER_API_TOKEN} as JS and the published page shows a broken header.
    expect(section).toContain("Bearer \\${LOOPOVER_API_TOKEN}");
    expect(section).not.toContain('"Bearer ${LOOPOVER_API_TOKEN}"');
  });

  it("prints one init-client command per pair, so the page and the CLI enumerate the same surface", () => {
    for (const mode of CONNECTION_MODES) {
      for (const host of CLIENT_HOSTS.filter((candidate) => supportsConnectionMode(candidate, mode))) {
        expect(section).toContain(`loopover-mcp init-client --print ${host}${mode === "stdio" ? "" : ` --mode ${mode}`}`);
      }
    }
  });
});

describe("the generated README sections (#9526)", () => {
  it("the stdio README documents both the gateway and the remote endpoint", () => {
    const section = stdioReadmeSection();
    expect(section).toContain(CONNECTION_MODE_SPEC.stdio.title);
    expect(section).toContain(CONNECTION_MODE_SPEC.remote.title);
    expect(section).toContain("https://api.loopover.ai/mcp");
  });

  it("the miner README's combined block registers BOTH servers and stays valid JSON", () => {
    const block = minerReadmeSection().match(/```json\r?\n([\s\S]*?)\r?\n```/)![1]!;
    const config = JSON.parse(block) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).toEqual({
      loopover: { command: "loopover-mcp", args: ["--stdio"] },
      "loopover-miner": { command: "loopover-miner-mcp", args: [] },
    });
  });
});

describe("the marker contract (#9526)", () => {
  it("replaces only what is between the markers, keeping both in place", () => {
    const replaced = replaceBetweenMarkers("head\nBEGIN\nold\nEND\ntail", "new", "BEGIN", "END", "probe");
    expect(replaced).toBe("head\nBEGIN\n\nnew\n\nEND\ntail");
  });

  it.each([
    ["a missing BEGIN", "END only"],
    ["a missing END", "BEGIN only"],
  ])("FAILS on %s rather than silently generating nothing", (_label, source) => {
    // A generator that quietly writes nowhere is the exact rot this whole family of checks exists to catch.
    expect(() => replaceBetweenMarkers(source, "new", "BEGIN", "END", "probe")).toThrow(/missing the GENERATED:MCP-CLIENT-CONFIG markers/);
  });
});

describe("the committed surfaces are up to date (#9526)", () => {
  it.each([
    ["apps/loopover-ui/content/docs/mcp-clients.mdx", docsSection],
    ["packages/loopover-mcp/README.md", stdioReadmeSection],
    ["packages/loopover-miner/README.md", minerReadmeSection],
  ])("%s contains the current generated block", (file, build) => {
    expect(read(file)).toContain(build());
  });

  it("the docs page has no hand-written config block left outside the markers", () => {
    const source = read("apps/loopover-ui/content/docs/mcp-clients.mdx");
    const outside = source.slice(0, source.indexOf("{/* GENERATED:MCP-CLIENT-CONFIG:BEGIN")) + source.slice(source.indexOf("{/* GENERATED:MCP-CLIENT-CONFIG:END */}"));
    expect(outside).not.toContain("mcpServers");
    expect(outside).not.toContain("mcp_servers");
  });
});
