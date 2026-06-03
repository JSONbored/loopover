import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

// Forbidden terms that must never appear in any public-facing MCP description or content.
const FORBIDDEN_PUBLIC_TERMS = /\b(wallet|hotkey|coldkey|mnemonic|seed phrase|payout)\b/i;

// Broader set for resource and prompt descriptions which are user-facing.
const FORBIDDEN_RESOURCE_PROMPT_TERMS =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|raw trust|trust score|reward estimate|farming|private reviewability|scoreability|private ranking/i;

async function connectTestClient() {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

// ── Tool discovery ────────────────────────────────────────────────────────────

describe("MCP tool discovery", () => {
  it("lists the known gittensory tool set and keeps descriptions free of forbidden terms", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);

    const names = tools.map((t) => t.name);
    expect(names).toContain("gittensory_get_repo_context");
    expect(names).toContain("gittensory_get_decision_pack");
    expect(names).toContain("gittensory_monitor_open_prs");
    expect(names).toContain("gittensory_preflight_pr");
    expect(names).toContain("gittensory_local_status");
    expect(names).toContain("gittensory_agent_plan_next_work");

    for (const tool of tools) {
      expect(tool.description ?? "", `tool "${tool.name}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    }
  });

  it("all registered tool names are prefixed with gittensory_", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.name).toMatch(/^gittensory_/);
    }
  });

  it("tool list is stable — fails if any expected tool is removed", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    const required = [
      "gittensory_get_repo_context",
      "gittensory_get_burden_forecast",
      "gittensory_get_repo_outcome_patterns",
      "gittensory_get_contributor_profile",
      "gittensory_get_decision_pack",
      "gittensory_monitor_open_prs",
      "gittensory_explain_repo_decision",
      "gittensory_preflight_pr",
      "gittensory_get_bounty_advisory",
      "gittensory_get_registry_changes",
      "gittensory_get_upstream_drift",
      "gittensory_get_issue_quality",
      "gittensory_preflight_local_diff",
      "gittensory_preview_local_pr_score",
      "gittensory_explain_review_risk",
      "gittensory_compare_pr_variants",
      "gittensory_local_status",
      "gittensory_preflight_current_branch",
      "gittensory_preview_current_branch_score",
      "gittensory_rank_local_next_actions",
      "gittensory_explain_local_blockers",
      "gittensory_prepare_pr_packet",
      "gittensory_compare_local_variants",
      "gittensory_agent_plan_next_work",
      "gittensory_agent_start_run",
      "gittensory_agent_get_run",
      "gittensory_agent_explain_next_action",
      "gittensory_agent_prepare_pr_packet",
    ];

    for (const name of required) {
      expect(names.has(name), `expected tool "${name}" to be registered`).toBe(true);
    }
  });
});

// ── Resource discovery ────────────────────────────────────────────────────────

describe("MCP resource discovery", () => {
  it("no resources are currently registered — listing resources is unavailable", async () => {
    const { mcpServer } = await connectTestClient();
    const resources = (mcpServer as unknown as { _registeredResources: Record<string, unknown> })._registeredResources;
    const templates = (mcpServer as unknown as { _registeredResourceTemplates: Record<string, unknown> })._registeredResourceTemplates;
    expect(Object.keys(resources)).toHaveLength(0);
    expect(Object.keys(templates)).toHaveLength(0);
  });

  it("reading a non-existent resource URI fails safely", async () => {
    const { client } = await connectTestClient();
    await expect(client.readResource({ uri: "gittensory://nonexistent" })).rejects.toThrow();
  });

  it("resource descriptions must not expose forbidden terms when resources are added", async () => {
    const { mcpServer } = await connectTestClient();
    const resources = (mcpServer as unknown as { _registeredResources: Record<string, { description?: string; title?: string }> })._registeredResources;
    const templates = (mcpServer as unknown as { _registeredResourceTemplates: Record<string, { description?: string; title?: string }> })._registeredResourceTemplates;

    for (const [uri, resource] of Object.entries(resources)) {
      expect(resource.description ?? "", `resource "${uri}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_RESOURCE_PROMPT_TERMS);
    }
    for (const [name, template] of Object.entries(templates)) {
      expect(template.description ?? "", `resource template "${name}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_RESOURCE_PROMPT_TERMS);
    }
  });
});

// ── Prompt discovery ──────────────────────────────────────────────────────────

const EXPECTED_PROMPTS = [
  "gittensory_triage_maintainer_queue",
  "gittensory_prepare_pr_review",
  "gittensory_draft_public_contributor_guidance",
  "gittensory_assess_intake_readiness",
  "gittensory_review_focus_manifest",
  "gittensory_plan_contributor_onboarding",
];

describe("MCP prompt discovery", () => {
  it("lists all expected maintainer and repo-owner prompts", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();

    const names = prompts.map((p) => p.name);
    for (const expected of EXPECTED_PROMPTS) {
      expect(names, `expected prompt "${expected}" to be registered`).toContain(expected);
    }
  });

  it("all prompt names are prefixed with gittensory_", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      expect(prompt.name).toMatch(/^gittensory_/);
    }
  });

  it("prompt descriptions and titles do not expose forbidden public terms", async () => {
    const { client } = await connectTestClient();
    const { prompts } = await client.listPrompts();

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt.description ?? "", `prompt "${prompt.name}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_RESOURCE_PROMPT_TERMS);
    }
  });

  it("getting a non-existent prompt fails safely", async () => {
    const { client } = await connectTestClient();
    await expect(client.getPrompt({ name: "nonexistent" })).rejects.toThrow();
  });

  it("prompt list is stable — fails if any expected prompt is removed", async () => {
    const { mcpServer } = await connectTestClient();
    const prompts = (mcpServer as unknown as { _registeredPrompts: Record<string, unknown> })._registeredPrompts;
    for (const name of EXPECTED_PROMPTS) {
      expect(Object.keys(prompts), `expected prompt "${name}" to be registered`).toContain(name);
    }
  });
});

// ── Prompt content safety ─────────────────────────────────────────────────────

describe("MCP prompt content safety", () => {
  it("returned prompt messages do not expose private terms for any repo-owner prompt", async () => {
    const { client } = await connectTestClient();
    const ownerPrompts = [
      "gittensory_assess_intake_readiness",
      "gittensory_review_focus_manifest",
      "gittensory_plan_contributor_onboarding",
    ];

    for (const name of ownerPrompts) {
      const result = await client.getPrompt({ name, arguments: { owner: "test-owner", repo: "test-repo" } });
      for (const message of result.messages) {
        const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
        expect(text, `prompt "${name}" message must not contain forbidden terms`).not.toMatch(FORBIDDEN_RESOURCE_PROMPT_TERMS);
      }
    }
  });

  it("returned prompt messages do not expose private terms for any maintainer prompt", async () => {
    const { client } = await connectTestClient();

    const queueResult = await client.getPrompt({ name: "gittensory_triage_maintainer_queue", arguments: { owner: "test-owner", repo: "test-repo" } });
    const guidanceResult = await client.getPrompt({ name: "gittensory_draft_public_contributor_guidance", arguments: { owner: "test-owner", repo: "test-repo" } });
    const reviewResult = await client.getPrompt({ name: "gittensory_prepare_pr_review", arguments: { owner: "test-owner", repo: "test-repo", pullNumber: "1" } });

    for (const [name, result] of [
      ["gittensory_triage_maintainer_queue", queueResult],
      ["gittensory_draft_public_contributor_guidance", guidanceResult],
      ["gittensory_prepare_pr_review", reviewResult],
    ] as const) {
      for (const message of result.messages) {
        const text = typeof message.content === "object" && "text" in message.content ? (message.content.text as string) : "";
        expect(text, `prompt "${name}" message must not contain forbidden terms`).not.toMatch(FORBIDDEN_RESOURCE_PROMPT_TERMS);
      }
    }
  });

  it("prompt messages confirm advisory-only intent — no autonomous GitHub writes", async () => {
    const { client } = await connectTestClient();

    for (const name of EXPECTED_PROMPTS) {
      const args = name.includes("pr_review")
        ? { owner: "o", repo: "r", pullNumber: "1" }
        : { owner: "o", repo: "r" };
      const result = await client.getPrompt({ name, arguments: args });
      const allText = result.messages
        .map((m) => (typeof m.content === "object" && "text" in m.content ? (m.content.text as string) : ""))
        .join(" ");
      // Every prompt must instruct the agent to refrain from autonomous GitHub writes.
      expect(allText, `prompt "${name}" must clarify advisory-only intent`).toMatch(
        /do not|requires.*approval|human.*approval|manually|no.*autonomous|not.*post|not.*modify|not.*creat/i,
      );
    }
  });
});
