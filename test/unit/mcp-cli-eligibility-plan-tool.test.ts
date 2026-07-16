import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// #6621: loopover_get_eligibility_plan was the one tool in the preview/breakdown/eligibility trio with no CLI
// mirror. It shares loopover_explain_score_breakdown's request-body assembly via buildLocalScoreRequestBody, so
// what is worth pinning here is the tool's own surface: that it is registered under the right schema, that its
// zod shape rejects bad input, and that the shared helper's contributorLogin guard fires BEFORE any workspace
// or network work. The composed body + apiPost round-trip is covered server-side by routes-eligibility-plan.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

describe("loopover_get_eligibility_plan stdio mirror (#6621)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let configDir: string;

  async function connect() {
    configDir = mkdtempSync(join(tmpdir(), "loopover-eligibility-plan-"));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: { ...env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
    });
    client = new Client({ name: "eligibility-plan-tool-test", version: "0.0.1" });
    await client.connect(transport);
  }

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it("registers the tool alongside its explain_score_breakdown sibling", async () => {
    await connect();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_get_eligibility_plan");
    expect(names).toContain("loopover_explain_score_breakdown");
  });

  it("advertises the same input schema as its sibling (both take localScoreShape)", async () => {
    await connect();
    const { tools } = await client.listTools();
    const plan = tools.find((t) => t.name === "loopover_get_eligibility_plan");
    const breakdown = tools.find((t) => t.name === "loopover_explain_score_breakdown");
    expect(plan?.inputSchema).toEqual(breakdown?.inputSchema);
    expect(plan?.description).toMatch(/eligib/i);
  });

  it("fails fast when no contributorLogin resolves — the shared helper guards before any workspace/network work", async () => {
    await connect();
    const outcome = await client
      .callTool({ name: "loopover_get_eligibility_plan", arguments: { repoFullName: "acme/widgets" } })
      .then((r) => ({ isError: Boolean(r.isError), text: JSON.stringify(r) }), (e: unknown) => ({ isError: true, text: String(e) }));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/contributorLogin is required for an eligibility plan/);
  });

  it("rejects invalid input (zod input-schema validation)", async () => {
    await connect();
    for (const args of [{}, { repoFullName: "" }, { repoFullName: "acme/widgets", linkedIssueMode: "bogus" }]) {
      const rejected = await client.callTool({ name: "loopover_get_eligibility_plan", arguments: args }).then(
        (r) => Boolean(r.isError),
        () => true,
      );
      expect(rejected, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
  });
});
