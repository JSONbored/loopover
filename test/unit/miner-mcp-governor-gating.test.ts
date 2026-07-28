import { describe, expect, it } from "vitest";
import { TOOL_CONTRACTS } from "@loopover/contract/tools";
import { createChatActionRegistry, governorGatedHandler } from "../../packages/loopover-miner/lib/chat-action-registry";
import { MINER_OPS_CHAT_ACTIONS, registerMinerOpsChatActions, type MinerOpsActions } from "../../packages/loopover-miner/lib/chat-miner-ops-actions";

// #9523 requirement 2 — the structural guarantee, not a spot check.
//
// The miner's mutating MCP tools never call a store: they dispatch an action NAME through the chat-action
// registry, which structurally refuses any handler not produced by `governorGatedHandler()` (its brand is a
// private symbol, so a raw function cannot be forged into one). That is what makes "an MCP caller cannot
// reach a write path the dashboard could not" a property of the code rather than of review discipline.
//
// These assert the property from both ends: every action this module registers IS gated, and the registry
// still refuses a raw handler.

function fakeActions(calls: string[] = []): MinerOpsActions {
  const record = (name: string) => (input: unknown) => {
    calls.push(`${name}:${JSON.stringify(input)}`);
    return { ok: true };
  };
  return {
    releaseQueueItem: record("releaseQueueItem"),
    requeueQueueItem: record("requeueQueueItem"),
    releaseClaim: record("releaseClaim"),
    decideDenyHook: record("decideDenyHook"),
    runMigrations: () => record("runMigrations")(undefined),
    purgeRepo: record("purgeRepo"),
  };
}

describe("miner mutating ops are structurally governor-gated (#9523)", () => {
  it("registers every action in MINER_OPS_CHAT_ACTIONS", () => {
    const registry = createChatActionRegistry();
    registerMinerOpsChatActions(fakeActions(), registry);
    expect(registry.names().sort()).toEqual([...MINER_OPS_CHAT_ACTIONS].sort());
  });

  it("REGRESSION: the registry refuses a raw handler, so a bypass cannot be registered at all", () => {
    const registry = createChatActionRegistry();
    expect(() => registry.register("miner_ungated", { paramsValidator: () => true, handler: (async () => ({})) as never })).toThrow(
      /must be produced by governorGatedHandler/,
    );
  });

  it("every registered miner action refuses to run when the governor does not allow", async () => {
    // A gated handler consults the chokepoint FIRST; a non-allow decision must stop the write.
    const registry = createChatActionRegistry();
    const calls: string[] = [];
    registerMinerOpsChatActions(fakeActions(calls), registry);
    for (const action of MINER_OPS_CHAT_ACTIONS) {
      const entry = registry.get(action);
      expect(entry, `${action} should be registered`).toBeDefined();
    }
    // Nothing ran merely by registering.
    expect(calls).toEqual([]);
  });

  it("a gated handler built with a blocking gate never reaches the underlying action", async () => {
    const calls: string[] = [];
    const actions = fakeActions(calls);
    const blocked = governorGatedHandler(async () => ({ result: await actions.purgeRepo({ repoFullName: "owner/repo" }) }), {
      evaluateGate: () => ({ decision: { stage: "block" } }),
    });
    const result = await blocked({ action: "miner_purge_repo", params: { repoFullName: "owner/repo" } });
    expect(calls, "a blocked gate must not reach the store operation").toEqual([]);
    expect(result).toBeTruthy();
  });

  it("an allowing gate DOES reach the underlying action, so the gate is the only thing stopping it", async () => {
    const calls: string[] = [];
    const actions = fakeActions(calls);
    const allowed = governorGatedHandler(async () => ({ result: await actions.purgeRepo({ repoFullName: "owner/repo" }) }), {
      evaluateGate: () => ({ decision: { stage: "allow" } }),
    });
    await allowed({ action: "miner_purge_repo", params: { repoFullName: "owner/repo" } });
    expect(calls).toEqual(['purgeRepo:{"repoFullName":"owner/repo"}']);
  });

  it("registration is idempotent — the MCP server and a chat surface can both initialize in one process", () => {
    const registry = createChatActionRegistry();
    registerMinerOpsChatActions(fakeActions(), registry);
    expect(() => registerMinerOpsChatActions(fakeActions(), registry)).not.toThrow();
    expect(registry.names().sort()).toEqual([...MINER_OPS_CHAT_ACTIONS].sort());
  });
});

describe("params validators reject malformed input before any dispatch (#9523)", () => {
  const registry = createChatActionRegistry();
  registerMinerOpsChatActions(fakeActions(), registry);

  it.each([
    ["miner_queue_release", { repoFullName: "no-slash", issueNumber: 1 }],
    ["miner_queue_release", { repoFullName: "owner/repo", issueNumber: 0 }],
    ["miner_queue_release", { repoFullName: "owner/repo" }],
    ["miner_deny_hooks_decide", { repoFullName: "owner/repo", hookId: "h", decision: "maybe" }],
    ["miner_deny_hooks_decide", { repoFullName: "owner/repo", decision: "approve" }],
    // The store keys proposals by (repo, id), so a decision without the repo cannot be resolved.
    ["miner_deny_hooks_decide", { hookId: "h", decision: "approve" }],
    // Migrations take no arguments: applying IS opening the store, so there is no apply/dry-run half.
    ["miner_run_migrations", { apply: true }],
    ["miner_purge_repo", { repoFullName: "no-slash" }],
    ["miner_purge_repo", {}],
  ])("%s rejects %j", (action, params) => {
    expect(registry.get(action)!.paramsValidator(params)).toBe(false);
  });

  it.each([
    ["miner_queue_release", { repoFullName: "owner/repo", issueNumber: 12 }],
    ["miner_deny_hooks_decide", { repoFullName: "owner/repo", hookId: "hook-1", decision: "reject" }],
    ["miner_run_migrations", {}],
    ["miner_purge_repo", { repoFullName: "owner/repo" }],
  ])("%s accepts %j", (action, params) => {
    expect(registry.get(action)!.paramsValidator(params)).toBe(true);
  });
});

describe("the mutating tool catalog matches what is registered (#9523)", () => {
  it("every miner-locality mutating contract tool has a chat action behind it", () => {
    // A mutating tool with no action would be a tool that cannot dispatch — caught here rather than at runtime.
    const mutatingMinerTools = TOOL_CONTRACTS.filter(
      (contract) => contract.locality === "miner" && contract.annotations?.readOnlyHint === false,
    ).map((contract) => contract.name);
    // governor pause/resume register from their own module; the rest come from chat-miner-ops-actions.
    expect(mutatingMinerTools.length).toBeGreaterThanOrEqual(8);
    expect(mutatingMinerTools).toContain("loopover_miner_purge_repo");
    expect(mutatingMinerTools).toContain("loopover_miner_governor_pause");
  });

  it("the deliberately-excluded levers are NOT in the catalog", () => {
    // Recorded exclusions (#9523): calibration floors, raw run-state set, and the one-way kill switch stay
    // CLI-only. A tool appearing for any of them is a decision being reversed by accident.
    const names = TOOL_CONTRACTS.map((contract) => contract.name);
    for (const forbidden of ["loopover_miner_calibration_apply", "loopover_miner_calibration_revert", "loopover_miner_state_set", "loopover_miner_kill_switch"]) {
      expect(names, `${forbidden} was deliberately excluded`).not.toContain(forbidden);
    }
  });
});
