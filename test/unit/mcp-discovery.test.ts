import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/loopover-mcp.js");

const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-discovery-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "discovery-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}


describe("MCP workspace root boundaries", () => {
  it("applies client-advertised roots to structured local status cwd requests", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gittensory-roots-"));
    const advertisedWorkspace = join(tempRoot, "advertised-workspace");
    const privateRepo = join(tempRoot, "private-repo-outside-root");
    const localConfigDir = join(tempRoot, "config");
    mkdirSync(advertisedWorkspace, { recursive: true });
    mkdirSync(privateRepo, { recursive: true });
    mkdirSync(localConfigDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: privateRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "security@example.com"], { cwd: privateRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Security Test"], { cwd: privateRepo, stdio: "ignore" });

    const rootedTransport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: {
        ...process.env,
        GITTENSORY_CONFIG_DIR: localConfigDir,
        GITTENSORY_API_TIMEOUT_MS: "1000",
      },
    });
    const rootedClient = new Client({ name: "roots-boundary-test", version: "0.0.1" }, { capabilities: { roots: {} } });
    rootedClient.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(advertisedWorkspace).href, name: "advertised-workspace" }],
    }));

    try {
      await rootedClient.connect(rootedTransport);
      const result = await rootedClient.callTool({ name: "loopover_local_status_structured", arguments: { cwd: privateRepo } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        git: { error: "Selected workspace is outside the MCP roots exposed by the client." },
      });
    } finally {
      await rootedClient.close().catch(() => undefined);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("MCP resource discovery", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("discovers all expected resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("gittensory://changelog");
    expect(uris).toContain("gittensory://compatibility");
  });

  it("resource descriptions do not expose forbidden public terms", async () => {
    const { resources } = await client.listResources();
    for (const resource of resources) {
      const text = [resource.name, resource.description ?? ""].join(" ");
      expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    }
  });

  it("does not expose deterministic slop weights as a discoverable resource", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).not.toContain("gittensory://slop-rules");
  });

  it("can read the changelog resource without authentication", async () => {
    const result = await client.readResource({ uri: "gittensory://changelog" });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content?.mimeType).toBe("text/markdown");
    if (!content || !("text" in content)) throw new Error("expected text content");
    expect(typeof content.text).toBe("string");
    expect(content.text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("can read the compatibility resource and get structured JSON", async () => {
    const result = await client.readResource({ uri: "gittensory://compatibility" });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content?.mimeType).toBe("application/json");
    if (!content || !("text" in content)) throw new Error("expected text content");
    // Must be parseable JSON (either real API response or unavailable fallback).
    expect(() => JSON.parse(content.text ?? "")).not.toThrow();
  });

  it("decision-pack resource template is discoverable", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const names = resourceTemplates.map((t) => t.name);
    expect(names).toContain("gittensory_decision_pack");
  });
});

describe("MCP prompt discovery", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("discovers all expected miner planning prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("gittensory_miner_select_issue");
    expect(names).toContain("gittensory_miner_draft_pr_packet");
    expect(names).toContain("gittensory_miner_branch_preflight");
    expect(names).toContain("gittensory_miner_cleanup_first");
  });

  it("discovers all expected maintainer and repo-owner prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("gittensory_maintainer_queue_triage");
    expect(names).toContain("gittensory_maintainer_review_prep");
    expect(names).toContain("gittensory_maintainer_public_guidance");
    expect(names).toContain("gittensory_repo_owner_intake_readiness");
    expect(names).toContain("gittensory_repo_owner_focus_manifest_review");
    expect(names).toContain("gittensory_repo_owner_onboarding_pack");
  });

  it("prompt descriptions do not expose forbidden public terms", async () => {
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      const text = [prompt.name, prompt.description ?? ""].join(" ");
      expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    }
  });

  it("miner prompts require expected arguments", async () => {
    const { prompts } = await client.listPrompts();

    const selectIssue = prompts.find((p) => p.name === "gittensory_miner_select_issue");
    const argNames = selectIssue?.arguments?.map((a) => a.name) ?? [];
    expect(argNames).toContain("repoFullName");
    expect(argNames).toContain("login");

    const cleanupFirst = prompts.find((p) => p.name === "gittensory_miner_cleanup_first");
    const cleanupArgs = cleanupFirst?.arguments?.map((a) => a.name) ?? [];
    expect(cleanupArgs).toContain("login");
  });

  it("maintainer review prep prompt requires pullNumber and repoFullName arguments", async () => {
    const { prompts } = await client.listPrompts();
    const reviewPrep = prompts.find((p) => p.name === "gittensory_maintainer_review_prep");
    const argNames = reviewPrep?.arguments?.map((a) => a.name) ?? [];
    expect(argNames).toContain("repoFullName");
    expect(argNames).toContain("pullNumber");
  });
});

describe("MCP prompt content safety", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("miner select-issue prompt text enforces no-write and no-credential boundaries", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_select_issue", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = result.messages.map((m) => (typeof m.content === "object" && "text" in m.content ? m.content.text : "")).join("\n");
    expect(text).toMatch(/do not open|do not.*comment|do not.*label|do not.*close|do not.*merge/i);
    expect(text).toMatch(/do not request wallet|do not request.*hotkey|do not request.*coldkey/i);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("miner cleanup-first prompt text enforces no-write boundary", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_cleanup_first", arguments: { login: "dev" } });
    const text = result.messages.map((m) => (typeof m.content === "object" && "text" in m.content ? m.content.text : "")).join("\n");
    expect(text).toMatch(/do not close|do not.*comment|do not.*merge/i);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("maintainer queue triage prompt enforces no-autonomous-write boundary", async () => {
    const result = await client.getPrompt({ name: "gittensory_maintainer_queue_triage", arguments: { repoFullName: "owner/repo" } });
    const text = result.messages.map((m) => (typeof m.content === "object" && "text" in m.content ? m.content.text : "")).join("\n");
    expect(text).toMatch(/do not post|do not.*merge|do not.*label/i);
    expect(text).toMatch(/do not expose.*private|no.*private scoreability|no.*raw trust/i);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("maintainer public guidance prompt forbids compensation language and autonomous posting", async () => {
    const result = await client.getPrompt({ name: "gittensory_maintainer_public_guidance", arguments: { repoFullName: "owner/repo", contributorLogin: "dev" } });
    const text = result.messages.map((m) => (typeof m.content === "object" && "text" in m.content ? m.content.text : "")).join("\n");
    expect(text).toMatch(/do not post.*autonomously|present it for/i);
    expect(text).toMatch(/no compensation language/i);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("repo-owner prompts forbid autonomous repo edits and private data exposure", async () => {
    for (const name of ["gittensory_repo_owner_intake_readiness", "gittensory_repo_owner_focus_manifest_review", "gittensory_repo_owner_onboarding_pack"]) {
      const result = await client.getPrompt({ name, arguments: { repoFullName: "owner/repo" } });
      const text = result.messages.map((m) => (typeof m.content === "object" && "text" in m.content ? m.content.text : "")).join("\n");
      expect(text).toMatch(/do not autonomously|do not.*push|present.*manually/i);
      expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    }
  });
});
