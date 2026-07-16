import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #6619: the CLI mirror of the remote server's loopover_get_pr_ai_review_findings. The tool only resolves the
// author login and proxies to GET /v1/repos/:owner/:repo/pulls/:number/ai-review-findings — the route (and the
// loadPrAiReviewFindings it delegates to) stays the single source of truth, so these tests assert the request
// the tool composes (path + login query param) and its login-resolution fallback chain, not the findings logic.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let capturedRequests: Array<{ url: string; method: string }>;

/** Connect a stdio client with `env` overlaid, so each test drives its own login-resolution scenario. */
async function connect(env: Record<string, string> = {}) {
  configDir = mkdtempSync(join(tmpdir(), "loopover-pr-ai-findings-"));
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url?.includes("/ai-review-findings")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) childEnv[key] = value;
  // Dropped unless a test opts back in, so the RUNNER's own env can't satisfy the login fallback by accident.
  delete childEnv.LOOPOVER_LOGIN;
  delete childEnv.GITHUB_LOGIN;
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...childEnv,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
      ...env,
    },
  });
  client = new Client({ name: "pr-ai-findings-test", version: "0.0.1" });
  await client.connect(transport);
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_get_pr_ai_review_findings stdio mirror (#6619)", () => {
  it("registers the tool in the stdio server tool list", async () => {
    await connect({ LOOPOVER_LOGIN: "octocat" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_get_pr_ai_review_findings");
  });

  it("proxies to the route with an explicit login and returns the structured findings", async () => {
    await connect();
    const result = await client.callTool({
      name: "loopover_get_pr_ai_review_findings",
      arguments: { owner: "owner", repo: "repo", number: 7, login: "octocat" },
    });
    expect(result.isError).toBeFalsy();
    expect(capturedRequests).toHaveLength(1);
    const captured = capturedRequests[0]!;
    expect(captured.method).toBe("GET");
    expect(captured.url).toContain("/v1/repos/owner/repo/pulls/7/ai-review-findings");
    expect(captured.url).toContain("login=octocat");
    const text = JSON.stringify(result);
    expect(text).toContain("correctness");
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("falls back to LOOPOVER_LOGIN when no login argument is given", async () => {
    await connect({ LOOPOVER_LOGIN: "env-login" });
    const result = await client.callTool({ name: "loopover_get_pr_ai_review_findings", arguments: { owner: "owner", repo: "repo", number: 7 } });
    expect(result.isError).toBeFalsy();
    expect(capturedRequests[0]!.url).toContain("login=env-login");
  });

  it("falls back to GITHUB_LOGIN when LOOPOVER_LOGIN is unset", async () => {
    await connect({ GITHUB_LOGIN: "gh-login" });
    const result = await client.callTool({ name: "loopover_get_pr_ai_review_findings", arguments: { owner: "owner", repo: "repo", number: 7 } });
    expect(result.isError).toBeFalsy();
    expect(capturedRequests[0]!.url).toContain("login=gh-login");
  });

  it("prefers an explicit login argument over the environment fallbacks", async () => {
    await connect({ LOOPOVER_LOGIN: "env-login", GITHUB_LOGIN: "gh-login" });
    await client.callTool({ name: "loopover_get_pr_ai_review_findings", arguments: { owner: "owner", repo: "repo", number: 7, login: "explicit" } });
    expect(capturedRequests[0]!.url).toContain("login=explicit");
  });

  it("errors with actionable guidance — and never calls the API — when no login resolves anywhere", async () => {
    await connect();
    const outcome = await client
      .callTool({ name: "loopover_get_pr_ai_review_findings", arguments: { owner: "owner", repo: "repo", number: 7 } })
      .then((r) => ({ isError: Boolean(r.isError), text: JSON.stringify(r) }), (e: unknown) => ({ isError: true, text: String(e) }));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/LOOPOVER_LOGIN|loopover-mcp login/);
    expect(capturedRequests).toHaveLength(0);
  });

  it("url-encodes an owner/repo/login that would otherwise break the path or query", async () => {
    await connect();
    await client.callTool({
      name: "loopover_get_pr_ai_review_findings",
      arguments: { owner: "owner", repo: "repo", number: 7, login: "a b&c" },
    });
    expect(capturedRequests[0]!.url).toContain("login=a%20b%26c");
  });

  it("rejects invalid input (zod): a non-positive PR number and a blank login", async () => {
    await connect({ LOOPOVER_LOGIN: "octocat" });
    for (const args of [
      { owner: "owner", repo: "repo", number: 0 },
      { owner: "owner", repo: "repo", number: -1 },
      { owner: "", repo: "repo", number: 7 },
      { owner: "owner", repo: "repo", number: 7, login: "" },
    ]) {
      const outcome = await client.callTool({ name: "loopover_get_pr_ai_review_findings", arguments: args }).then(
        (r) => Boolean(r.isError),
        () => true,
      );
      expect(outcome, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
  });
});
