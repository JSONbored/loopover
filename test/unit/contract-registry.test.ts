// Meta-tests for @loopover/contract's registry (#9517).
//
// These assert the CONVENTIONS the package documents, so a contract that violates one fails here
// rather than being discovered as drift months later. They are the cheap, always-run half of the
// enforcement; the contract validator (#9520) is the expensive half that actually calls each tool
// and validates its structuredContent against the schema advertised below.
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import {
  TOOL_CATEGORIES,
  TOOL_AUTH_LEVELS,
  TOOL_LOCALITIES,
  TOOL_AVAILABILITIES,
  TOOL_CONTRACTS,
  listToolDefinitions,
  getToolContract,
  buildOpenAIToolSpecs,
  buildAnthropicToolSpecs,
  buildAgentToolsIndex,
  AGENT_TOOLS_INDEX_SCHEMA_VERSION,
  AUTONOMY_LEVELS,
  MAINTAIN_ACTION_CLASSES,
  PROPOSE_ACTION_CLASSES,
  PREFLIGHT_LIMITS,
  SCENARIO_LIMITS,
  PLAN_STEP_STATUSES,
  PUBLIC_SURFACE_SKIP_REASONS,
} from "@loopover/contract";
import { LocalStatusStructuredInput } from "@loopover/contract/tools";
import { GetRepoContextInput } from "@loopover/contract/tools";
import { PREFLIGHT_LIMITS as ENGINE_PREFLIGHT_LIMITS } from "../../packages/loopover-engine/src/signals/preflight-limits.js";
import { PUBLIC_SURFACE_SKIP_REASONS as SERVER_PUBLIC_SURFACE_SKIP_REASONS } from "../../src/signals/settings-preview";
import { AUTONOMY_LEVELS as ENGINE_AUTONOMY_LEVELS, AGENT_ACTION_CLASSES as ENGINE_AGENT_ACTION_CLASSES } from "../../packages/loopover-engine/src/settings/autonomy.js";
import { SCENARIO_MAX_REPO_FULL_NAME_CHARS, SCENARIO_MAX_BRANCH_REF_CHARS } from "../../src/scenarios/input-model";
import { PLAN_STATUSES } from "../../packages/loopover-miner/lib/plan-store.js";

describe("contract tool registry", () => {
  it("registers at least one tool", () => {
    expect(TOOL_CONTRACTS.length).toBeGreaterThan(0);
  });

  it("gives every tool a unique name", () => {
    const names = TOOL_CONTRACTS.map((contract) => contract.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every tool with the loopover_ prefix", () => {
    for (const contract of TOOL_CONTRACTS) {
      expect(contract.name, contract.name).toMatch(/^loopover_[a-z0-9_]+$/);
    }
  });

  it("gives every tool a substantive description and a title", () => {
    for (const contract of TOOL_CONTRACTS) {
      expect(contract.description.length, contract.name).toBeGreaterThan(20);
      expect(contract.title.trim().length, contract.name).toBeGreaterThan(0);
    }
  });

  it("draws category, auth, locality, and availability from the declared vocabularies", () => {
    for (const contract of TOOL_CONTRACTS) {
      expect(TOOL_CATEGORIES, contract.name).toContain(contract.category);
      expect(TOOL_AUTH_LEVELS, contract.name).toContain(contract.auth);
      expect(TOOL_LOCALITIES, contract.name).toContain(contract.locality);
      expect(TOOL_AVAILABILITIES, contract.name).toContain(contract.availability);
    }
  });

  it("declares input and output as zod objects, never bare unknowns", () => {
    for (const contract of TOOL_CONTRACTS) {
      expect(contract.input, contract.name).toBeInstanceOf(z.ZodObject);
      expect(contract.output, contract.name).toBeInstanceOf(z.ZodObject);
    }
  });

  it("resolves a contract by name and returns undefined for an unknown one", () => {
    const first = TOOL_CONTRACTS[0]!;
    expect(getToolContract(first.name)).toBe(first);
    expect(getToolContract("loopover_not_a_real_tool")).toBeUndefined();
  });
});

describe("contract projection", () => {
  const definitions = listToolDefinitions();

  it("projects every contract exactly once", () => {
    expect(definitions.map((tool) => tool.name).sort()).toEqual(TOOL_CONTRACTS.map((contract) => contract.name).sort());
  });

  it("emits object-typed JSON Schema that Ajv can compile for both input and output", () => {
    // strict:false mirrors the contract validator's own Ajv setup: draft-2020-12 output schemas
    // legitimately carry keywords Ajv's strict mode would reject as unknown.
    const ajv = new Ajv2020({ strict: false });
    for (const tool of definitions) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.outputSchema.type, tool.name).toBe("object");
      expect(() => ajv.compile(tool.inputSchema), `${tool.name} input`).not.toThrow();
      expect(() => ajv.compile(tool.outputSchema), `${tool.name} output`).not.toThrow();
    }
  });

  it("keeps output schemas open so an added server field cannot invalidate an older client", () => {
    // The wire-compatibility rule the README states: an MCP output schema is a floor, not a fence.
    // z.looseObject is what produces the open additionalProperties; a plain z.object would emit
    // `false` here and silently make every future field addition a breaking change.
    for (const tool of definitions) {
      expect(tool.outputSchema.additionalProperties, tool.name).not.toBe(false);
    }
  });

  it("advertises closed input schemas, matching the shape the MCP SDK already published", () => {
    // z.object emits additionalProperties:false. Note this is the ADVERTISED contract only: zod's
    // runtime STRIPS unknown keys rather than rejecting them (see the test below), so the two do
    // not agree today. Whether to close that gap with z.strictObject is a deliberate wire decision
    // recorded on #9518, not something to change silently during a behavior-preserving migration.
    for (const tool of listToolDefinitions()) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("strips rather than rejects an unknown input key, preserving today's runtime behavior", () => {
    // Pinned deliberately. The migration promised no wire-visible change, and this is the one place
    // where the advertised schema and the runtime disagree -- pinning it means a future switch to
    // strict parsing has to be an intentional edit to this assertion, not an accident.
    const parsed = LocalStatusStructuredInput.safeParse({ definitelyNotAField: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({});
  });

  it("rejects a known input field carrying the wrong type", () => {
    expect(GetRepoContextInput.safeParse({ owner: "a", repo: 5 }).success).toBe(false);
    expect(GetRepoContextInput.safeParse({ owner: "", repo: "b" }).success).toBe(false);
    expect(GetRepoContextInput.safeParse({ owner: "a", repo: "b" }).success).toBe(true);
  });

  it("defaults annotations to read-only and non-destructive", () => {
    const readOnly = definitions.find((tool) => !TOOL_CONTRACTS.find((c) => c.name === tool.name)?.annotations);
    expect(readOnly?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it("marks every destructive tool as not read-only", () => {
    // A tool cannot coherently claim to both mutate state and be read-only; this catches an entry
    // that sets destructiveHint without clearing the read-only default.
    for (const tool of definitions) {
      if (tool.annotations.destructiveHint) expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
    }
  });

  it("filters by locality, availability, and category without mutating the registry", () => {
    const remote = listToolDefinitions({ locality: ["remote"] });
    expect(remote.every((tool) => tool.locality === "remote")).toBe(true);
    expect(remote.length).toBeLessThanOrEqual(definitions.length);

    const selfhost = listToolDefinitions({ availability: ["selfhost"] });
    // `both` is the absence of a restriction, not a third deployment, so it must survive a
    // selfhost filter -- the bug this asserts against is treating it as a distinct value.
    expect(selfhost.every((tool) => tool.availability === "selfhost" || tool.availability === "both")).toBe(true);
    expect(selfhost.some((tool) => tool.availability === "both")).toBe(true);

    const cloud = listToolDefinitions({ availability: ["cloud"] });
    expect(cloud.some((tool) => tool.availability === "selfhost")).toBe(false);

    const admin = listToolDefinitions({ category: ["admin"] });
    expect(admin.every((tool) => tool.category === "admin")).toBe(true);

    // Combined filters intersect rather than union.
    const none = listToolDefinitions({ locality: ["miner"], availability: ["cloud"] });
    expect(none.every((tool) => tool.locality === "miner")).toBe(true);

    expect(TOOL_CONTRACTS.length).toBeGreaterThan(0);
  });
});

describe("agent tool specs", () => {
  const definitions = listToolDefinitions();

  it("projects OpenAI specs from the same definitions", () => {
    const specs = buildOpenAIToolSpecs(definitions);
    expect(specs).toHaveLength(definitions.length);
    for (const [index, spec] of specs.entries()) {
      const tool = definitions[index]!;
      expect(spec.type).toBe("function");
      expect(spec.function.name).toBe(tool.name);
      expect(spec.function.description).toBe(tool.description);
      expect(spec.function.parameters).toEqual(tool.inputSchema);
    }
  });

  it("projects Anthropic specs from the same definitions", () => {
    const specs = buildAnthropicToolSpecs(definitions);
    expect(specs).toHaveLength(definitions.length);
    for (const [index, spec] of specs.entries()) {
      const tool = definitions[index]!;
      expect(spec.name).toBe(tool.name);
      expect(spec.description).toBe(tool.description);
      expect(spec.input_schema).toEqual(tool.inputSchema);
    }
  });

  it("builds an agent-tools index carrying both spec flavors and the executor contract", () => {
    const index = buildAgentToolsIndex(definitions, { endpoint: "https://api.loopover.ai/mcp" });
    expect(index.schema_version).toBe(AGENT_TOOLS_INDEX_SCHEMA_VERSION);
    expect(index.executor).toEqual({
      transport: "mcp-streamable-http",
      endpoint: "https://api.loopover.ai/mcp",
      jsonrpc_method: "tools/call",
    });
    expect(index.tools).toEqual(definitions.map((tool) => tool.name));
    expect(index.specs.openai).toHaveLength(definitions.length);
    expect(index.specs.anthropic).toHaveLength(definitions.length);
  });

  it("returns empty specs for an empty tool list", () => {
    expect(buildOpenAIToolSpecs([])).toEqual([]);
    expect(buildAnthropicToolSpecs([])).toEqual([]);
    const index = buildAgentToolsIndex([], { endpoint: "https://example.test/mcp" });
    expect(index.tools).toEqual([]);
    expect(index.specs.openai).toEqual([]);
  });
});

describe("contract enums", () => {
  it("pins autonomy levels against the engine's live enum", () => {
    // packages/loopover-engine/src/settings/autonomy.ts still declares its own copy because it is
    // an engine-parity twin of src/settings/autonomy.ts; inverting that pair to import from the
    // contract is #9518's batch work. Until then this pin is what makes the two impossible to
    // drift apart -- the same technique test/unit/mcp-cli-maintain.test.ts used for the stdio
    // hand-copy this package replaces.
    expect([...AUTONOMY_LEVELS]).toEqual([...ENGINE_AUTONOMY_LEVELS]);
  });

  it("keeps the operator-settable action classes a strict subset of the engine's full list", () => {
    // MAINTAIN_ACTION_CLASSES is deliberately NOT the engine's full AGENT_ACTION_CLASSES -- it is
    // the subset the maintain surface exposes. Asserting subset-ness (rather than equality) pins
    // the intended relationship without re-coupling them.
    for (const actionClass of MAINTAIN_ACTION_CLASSES) {
      expect(ENGINE_AGENT_ACTION_CLASSES as readonly string[], actionClass).toContain(actionClass);
    }
    expect(MAINTAIN_ACTION_CLASSES.length).toBeLessThan(ENGINE_AGENT_ACTION_CLASSES.length);
  });

  it("derives the propose set as the maintain set plus review_state_label", () => {
    expect([...PROPOSE_ACTION_CLASSES]).toEqual([...MAINTAIN_ACTION_CLASSES, "review_state_label"]);
    for (const actionClass of PROPOSE_ACTION_CLASSES) {
      expect(ENGINE_AGENT_ACTION_CLASSES as readonly string[], actionClass).toContain(actionClass);
    }
  });

  it("pins the skipped-PR audit reason codes against the server's live enum", () => {
    // Same reason as the autonomy pins: the contract cannot import the Worker's src/, and a filter
    // vocabulary that silently stops matching the server's is worse than one that fails loudly.
    expect([...PUBLIC_SURFACE_SKIP_REASONS]).toEqual([...SERVER_PUBLIC_SURFACE_SKIP_REASONS]);
  });

  it("pins the preflight input bounds against the engine's live limits", () => {
    // The contract restates PREFLIGHT_LIMITS because it cannot import the engine (zod-only leaf).
    // Without this pin, raising a bound on one side only would produce a schema that either rejects
    // input the server accepts, or accepts input the server silently truncates.
    expect(PREFLIGHT_LIMITS).toEqual(ENGINE_PREFLIGHT_LIMITS);
  });

  it("pins the repo/branch identifier bounds against the server's live scenario limits", () => {
    // Same restatement, same hazard: the write-spec tools bound repoFullName and branch refs with
    // these, and a contract that accepted a longer ref than the server does would advertise input
    // the server rejects.
    expect(SCENARIO_LIMITS).toEqual({
      repoFullNameChars: SCENARIO_MAX_REPO_FULL_NAME_CHARS,
      branchRefChars: SCENARIO_MAX_BRANCH_REF_CHARS,
    });
  });

  it("uses one plan-step vocabulary across the remote plan DAG and the miner plan store", () => {
    // #9518: this list said `in_progress` where both real surfaces say `running`. Nothing consumed
    // it yet, so nothing broke -- but the first consumer would have rejected every running step the
    // plan store has ever persisted. The plan-level statuses are a strict subset (a plan cannot be
    // `skipped`), which is what makes them safe to compare this way.
    expect(PLAN_STEP_STATUSES).toContain("running");
    expect(PLAN_STEP_STATUSES).not.toContain("in_progress");
    for (const status of PLAN_STATUSES) {
      expect(PLAN_STEP_STATUSES as readonly string[], status).toContain(status);
    }
  });
});
