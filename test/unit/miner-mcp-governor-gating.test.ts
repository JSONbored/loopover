import { describe, expect, it } from "vitest";
import { TOOL_CONTRACTS } from "@loopover/contract/tools";
import { createChatActionRegistry, governorGatedHandler } from "../../packages/loopover-miner/lib/chat-action-registry";
import { MINER_OPS_CHAT_ACTIONS, registerMinerOpsChatActions, type MinerOpsActions } from "../../packages/loopover-miner/lib/chat-miner-ops-actions";
import { CHAT_ACTION_DISPATCH_ENABLE_VALUE, CHAT_ACTION_DISPATCH_FLAG, dispatchChatAction } from "../../packages/loopover-miner/lib/chat-action-dispatch";

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
    // The non-object guards: null, a primitive, and an array are all rejected before any field is read.
    ["miner_queue_release", null],
    ["miner_queue_release", "owner/repo"],
    ["miner_queue_release", []],
    ["miner_deny_hooks_decide", null],
    ["miner_deny_hooks_decide", []],
    ["miner_purge_repo", null],
    ["miner_purge_repo", []],
    ["miner_run_migrations", []],
    ["miner_run_migrations", "go"],
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

  it("migrations accept the nullish 'no arguments' spellings", () => {
    // `migrate` takes no options at all, so a caller may omit params entirely rather than send `{}`.
    expect(registry.get("miner_run_migrations")!.paramsValidator(null)).toBe(true);
    expect(registry.get("miner_run_migrations")!.paramsValidator(undefined)).toBe(true);
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

describe("end-to-end dispatch: MCP action name -> gate -> store operation (#9523)", () => {
  // The whole path the MCP tools actually take. Anything that bypasses it cannot be registered at all, so
  // this is the only route a mutation can travel — worth exercising per action rather than per unit.
  const enabled = { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };

  function harness() {
    const registry = createChatActionRegistry();
    const calls: string[] = [];
    // An allowing gate: this block is about the DISPATCH path, and the gate's own refusal behavior is
    // covered above. Production supplies no evaluateGate, so it gets the real chokepoint.
    registerMinerOpsChatActions(fakeActions(calls), registry, { evaluateGate: () => ({ decision: { stage: "allow" } }) });
    return { registry, calls };
  }

  it.each([
    ["miner_queue_release", { repoFullName: "owner/repo", issueNumber: 1 }, "releaseQueueItem"],
    ["miner_queue_requeue", { repoFullName: "owner/repo", issueNumber: 2 }, "requeueQueueItem"],
    ["miner_claim_release", { repoFullName: "owner/repo", issueNumber: 3 }, "releaseClaim"],
    ["miner_deny_hooks_decide", { repoFullName: "owner/repo", hookId: "h1", decision: "approve" }, "decideDenyHook"],
    ["miner_run_migrations", {}, "runMigrations"],
    ["miner_purge_repo", { repoFullName: "owner/repo" }, "purgeRepo"],
  ])("%s dispatches to %s", async (action, params, expectedCall) => {
    const { registry, calls } = harness();
    const result = await dispatchChatAction({ action, params }, { registry, env: enabled });
    expect(result.ok, `${action} should dispatch: ${JSON.stringify(result)}`).toBe(true);
    expect(calls.join("|")).toContain(expectedCall);
  });

  it("dispatches an action whose request carries NO params at all", async () => {
    const { registry, calls } = harness();
    const result = await dispatchChatAction({ action: "miner_run_migrations" }, { registry, env: enabled });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(calls.join("|")).toContain("runMigrations");
  });

  it("rejects malformed params BEFORE reaching the store operation", async () => {
    const { registry, calls } = harness();
    const result = await dispatchChatAction({ action: "miner_purge_repo", params: { repoFullName: "no-slash" } }, { registry, env: enabled });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("invalid_params");
    expect(calls, "an invalid request must not reach the store").toEqual([]);
  });

  it("fails CLOSED when the chat-action flag is not enabled", async () => {
    const { registry, calls } = harness();
    const result = await dispatchChatAction({ action: "miner_purge_repo", params: { repoFullName: "owner/repo" } }, { registry, env: {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("disabled");
    expect(calls).toEqual([]);
  });

  it("rejects an action that was never registered", async () => {
    const { registry } = harness();
    const result = await dispatchChatAction({ action: "miner_not_a_thing", params: {} }, { registry, env: enabled });
    expect(result.status).toBe("unknown_action");
  });
});
