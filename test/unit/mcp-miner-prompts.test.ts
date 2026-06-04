import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

// Forbidden terms that must never appear in miner planning prompt descriptions or content.
const FORBIDDEN_PROMPT_TERMS =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|raw trust|trust score|reward estimate|farming|private reviewability|scoreability|private ranking/i;

// Explicit secret-request patterns that prompts must never contain.
const FORBIDDEN_REQUEST_PATTERNS = /enter your (wallet|hotkey|token|seed|key|mnemonic|password)|provide your (wallet|hotkey|token|seed|key)|paste your (hotkey|wallet|key)/i;

const MINER_PROMPT_NAMES = [
  "gittensory_select_contribution_issue",
  "gittensory_draft_contribution_pr_packet",
  "gittensory_preflight_contribution_branch",
  "gittensory_plan_cleanup_first",
];

async function connectTestClient() {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-miner-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

// ── Discovery fixtures ────────────────────────────────────────────────────────

describe("MCP miner planning prompt discovery", () => {
  it("lists all miner planning prompts via client discovery", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);

    for (const expected of MINER_PROMPT_NAMES) {
      expect(names, `expected miner prompt "${expected}" to be discoverable`).toContain(expected);
    }
  });

  it("all miner prompt names are prefixed with gittensory_", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      expect(prompt.name).toMatch(/^gittensory_/);
    }
  });

  it("miner prompt descriptions do not expose forbidden terms", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();
    const minerPrompts = prompts.filter((p) => MINER_PROMPT_NAMES.includes(p.name));

    expect(minerPrompts.length).toBe(MINER_PROMPT_NAMES.length);
    for (const prompt of minerPrompts) {
      expect(prompt.description ?? "", `prompt "${prompt.name}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_PROMPT_TERMS);
    }
  });

  it("miner prompt inventory is stable — fails if any prompt is removed", async () => {
    const { mcpServer } = await connectTestClient();
    const registered = (mcpServer as unknown as { _registeredPrompts: Record<string, unknown> })._registeredPrompts;

    for (const name of MINER_PROMPT_NAMES) {
      expect(Object.keys(registered), `miner prompt "${name}" must remain registered`).toContain(name);
    }
  });

  it("getting a non-existent miner prompt fails safely", async () => {
    const { client } = await connectTestClient();
    await expect(client.getPrompt({ name: "gittensory_nonexistent_miner_prompt" })).rejects.toThrow();
  });
});

// ── Prompt content safety ─────────────────────────────────────────────────────

describe("MCP miner planning prompt content safety", () => {
  it("gittensory_select_contribution_issue message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_select_contribution_issue",
      arguments: { owner: "test-owner", repo: "test-repo", login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("gittensory_draft_contribution_pr_packet message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_draft_contribution_pr_packet",
      arguments: { owner: "test-owner", repo: "test-repo", login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("gittensory_preflight_contribution_branch message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_preflight_contribution_branch",
      arguments: { owner: "test-owner", repo: "test-repo", login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("gittensory_plan_cleanup_first message is free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.getPrompt({
      name: "gittensory_plan_cleanup_first",
      arguments: { login: "contributor" },
    });
    for (const message of result.messages) {
      const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
      expect(text).not.toMatch(FORBIDDEN_PROMPT_TERMS);
      expect(text).not.toMatch(FORBIDDEN_REQUEST_PATTERNS);
    }
  });

  it("all miner prompts confirm advisory-only intent — no autonomous GitHub writes", async () => {
    const { client } = await connectTestClient();
    const promptArgs: Record<string, Record<string, string>> = {
      gittensory_select_contribution_issue: { owner: "o", repo: "r", login: "dev" },
      gittensory_draft_contribution_pr_packet: { owner: "o", repo: "r", login: "dev" },
      gittensory_preflight_contribution_branch: { owner: "o", repo: "r", login: "dev" },
      gittensory_plan_cleanup_first: { login: "dev" },
    };

    for (const name of MINER_PROMPT_NAMES) {
      const result = await client.getPrompt({ name, arguments: promptArgs[name] });
      const allText = result.messages
        .map((m) => (typeof m.content === "object" && "text" in m.content ? (m.content.text as string) : ""))
        .join(" ");

      expect(allText, `prompt "${name}" must not claim to create issues or PRs`).not.toMatch(
        /\bcreate\s+(?:an?\s+)?(?:issue|pr|pull request|comment|label)\b/i,
      );
      expect(allText, `prompt "${name}" must not claim to merge or close`).not.toMatch(/\b(?:merge|close|push|commit)\b.*\bautomatically\b/i);
      expect(allText, `prompt "${name}" must clarify advisory-only intent`).toMatch(
        /do not|requires.*approval|human.*approval|manually|not.*autonomous|not.*post|not.*open.*pr|not.*create|not.*take.*action/i,
      );
    }
  });

  it("miner prompts do not request secrets, tokens, wallets, or hotkeys from the user", async () => {
    const { client } = await connectTestClient();
    const promptArgs: Record<string, Record<string, string>> = {
      gittensory_select_contribution_issue: { owner: "o", repo: "r", login: "dev" },
      gittensory_draft_contribution_pr_packet: { owner: "o", repo: "r", login: "dev" },
      gittensory_preflight_contribution_branch: { owner: "o", repo: "r", login: "dev" },
      gittensory_plan_cleanup_first: { login: "dev" },
    };

    for (const name of MINER_PROMPT_NAMES) {
      const result = await client.getPrompt({ name, arguments: promptArgs[name] });
      const allText = result.messages
        .map((m) => (typeof m.content === "object" && "text" in m.content ? (m.content.text as string) : ""))
        .join(" ");

      expect(allText, `prompt "${name}" must not request secrets or private credentials`).not.toMatch(
        /\b(?:wallet|hotkey|coldkey|mnemonic|seed phrase|private key|token|api key|password)\b/i,
      );
    }
  });
});
