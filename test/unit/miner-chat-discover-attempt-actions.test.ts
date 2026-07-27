import { describe, expect, it, vi } from "vitest";

// governor-chokepoint.js (imported transitively by chat-action-registry.js) pulls in @loopover/engine, whose
// dist is not built in the test workspace -- resolve it against source, matching the sibling miner tests.
vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
} from "../../packages/loopover-miner/lib/chat-action-dispatch";
import { chatActionRegistry, createChatActionRegistry } from "../../packages/loopover-miner/lib/chat-action-registry";
import {
  ATTEMPT_CHAT_ACTION,
  DISCOVER_CHAT_ACTION,
  isAttemptChatParams,
  isDiscoverChatParams,
  registerDiscoverAttemptChatActions,
} from "../../packages/loopover-miner/lib/chat-discover-attempt-actions";

const enabledEnv = { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };

const attemptParams = { repoFullName: "acme/widgets", issueNumber: 12, minerLogin: "miner" };
const okResult = { ok: true, result: { outcome: "submitted" }, exitCode: 0 };

type DiscoverInput = { targets?: string[]; search?: string; dryRun?: boolean; json?: boolean; apiBaseUrl?: string; tokenEnv?: string };
type AttemptInput = { repoFullName: string; issueNumber: number; minerLogin: string; base?: string; live?: boolean; dryRun?: boolean; json?: boolean };

function setup(over: Partial<Parameters<typeof registerDiscoverAttemptChatActions>[0]> = {}) {
  const registry = createChatActionRegistry();
  // Parameter-typed so `mock.calls[0][0]` is inspectable -- an untyped vi.fn infers a zero-length tuple.
  const requestDiscover = vi.fn(async (_input: DiscoverInput) => okResult);
  const requestAttempt = vi.fn(async (_input: AttemptInput) => okResult);
  registerDiscoverAttemptChatActions({ registry, requestDiscover, requestAttempt, ...over });
  return { registry, requestDiscover, requestAttempt };
}

describe("isDiscoverChatParams (#6837)", () => {
  it("accepts nullish and an empty object as 'discover with defaults'", () => {
    // Every DiscoverActionInput field is optional (the CLI defaults them all), unlike attempt.
    expect(isDiscoverChatParams(undefined)).toBe(true);
    expect(isDiscoverChatParams(null)).toBe(true);
    expect(isDiscoverChatParams({})).toBe(true);
  });

  it("accepts a fully specified input", () => {
    expect(
      isDiscoverChatParams({
        targets: ["acme/widgets"],
        search: "label:bug",
        dryRun: true,
        json: true,
        apiBaseUrl: "https://api.github.com",
        tokenEnv: "GITHUB_TOKEN",
      }),
    ).toBe(true);
  });

  it("rejects a non-object params value", () => {
    expect(isDiscoverChatParams("acme/widgets")).toBe(false);
    expect(isDiscoverChatParams([])).toBe(false);
    expect(isDiscoverChatParams(42)).toBe(false);
  });

  it("rejects a malformed targets list", () => {
    expect(isDiscoverChatParams({ targets: "acme/widgets" })).toBe(false);
    expect(isDiscoverChatParams({ targets: [42] })).toBe(false);
    expect(isDiscoverChatParams({ targets: [""] })).toBe(false);
    expect(isDiscoverChatParams({ targets: [] })).toBe(true); // empty list is a valid explicit "no targets"
  });

  it("rejects wrong-typed string and boolean fields", () => {
    expect(isDiscoverChatParams({ search: 42 })).toBe(false);
    expect(isDiscoverChatParams({ apiBaseUrl: 42 })).toBe(false);
    expect(isDiscoverChatParams({ tokenEnv: 42 })).toBe(false);
    expect(isDiscoverChatParams({ dryRun: "yes" })).toBe(false);
    expect(isDiscoverChatParams({ json: "yes" })).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // Model-authored params: a typo'd flag must fail loudly, not silently run a different discovery.
    expect(isDiscoverChatParams({ dry_run: true })).toBe(false);
    expect(isDiscoverChatParams({ targets: ["acme/widgets"], limit: 5 })).toBe(false);
  });
});

describe("isAttemptChatParams (#6837)", () => {
  it("accepts the required trio, with and without the optional fields", () => {
    expect(isAttemptChatParams(attemptParams)).toBe(true);
    expect(isAttemptChatParams({ ...attemptParams, base: "main", live: true, dryRun: false, json: true })).toBe(true);
  });

  it("rejects nullish and non-objects: there is no default issue to attempt", () => {
    expect(isAttemptChatParams(undefined)).toBe(false);
    expect(isAttemptChatParams(null)).toBe(false);
    expect(isAttemptChatParams([attemptParams])).toBe(false);
  });

  it("rejects a missing or empty required field", () => {
    expect(isAttemptChatParams({ issueNumber: 12, minerLogin: "miner" })).toBe(false);
    expect(isAttemptChatParams({ repoFullName: "acme/widgets", minerLogin: "miner" })).toBe(false);
    expect(isAttemptChatParams({ repoFullName: "acme/widgets", issueNumber: 12 })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, repoFullName: "  " })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, minerLogin: "" })).toBe(false);
  });

  it("rejects an issueNumber that is not a positive integer", () => {
    // A float or 0 would reach the CLI as a nonsense issue reference.
    expect(isAttemptChatParams({ ...attemptParams, issueNumber: 0 })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, issueNumber: -3 })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, issueNumber: 1.5 })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, issueNumber: "12" })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, issueNumber: Number.NaN })).toBe(false);
  });

  it("rejects wrong-typed optional fields", () => {
    expect(isAttemptChatParams({ ...attemptParams, base: 42 })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, live: "yes" })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, dryRun: 1 })).toBe(false);
    expect(isAttemptChatParams({ ...attemptParams, json: 1 })).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    expect(isAttemptChatParams({ ...attemptParams, issue_number: 12 })).toBe(false);
  });
});

describe("registerDiscoverAttemptChatActions (#6837)", () => {
  it("registers both actions on the supplied registry", () => {
    const { registry } = setup();
    expect(registry.names().sort()).toEqual([ATTEMPT_CHAT_ACTION, DISCOVER_CHAT_ACTION].sort());
  });

  it("throws when requestDiscover or requestAttempt is not a function", () => {
    const registry = createChatActionRegistry();
    expect(() => registerDiscoverAttemptChatActions({ registry, requestAttempt: async () => okResult } as never)).toThrow(
      "requestDiscover must be a function",
    );
    expect(() => registerDiscoverAttemptChatActions({ registry, requestDiscover: async () => okResult } as never)).toThrow(
      "requestAttempt must be a function",
    );
  });

  it("is idempotent: a second registration does not throw", () => {
    const { registry, requestDiscover, requestAttempt } = setup();
    expect(() => registerDiscoverAttemptChatActions({ registry, requestDiscover, requestAttempt })).not.toThrow();
    expect(registry.size).toBe(2);
  });

  it("falls back to the shared chatActionRegistry when no registry is supplied", () => {
    // The production wiring omits `registry`, so this nullish default is the path that actually ships -- every
    // other test here injects an isolated registry and would never exercise it.
    expect(chatActionRegistry.has(DISCOVER_CHAT_ACTION)).toBe(false);
    registerDiscoverAttemptChatActions({ requestDiscover: async () => okResult, requestAttempt: async () => okResult });
    expect(chatActionRegistry.has(DISCOVER_CHAT_ACTION)).toBe(true);
    expect(chatActionRegistry.has(ATTEMPT_CHAT_ACTION)).toBe(true);
  });
});

describe("discover/attempt chat actions through dispatchChatAction (#6837)", () => {
  it("runs discover via the injected miner-ui client, forwarding the exact input", async () => {
    const { registry, requestDiscover, requestAttempt } = setup();
    const input = { targets: ["acme/widgets"], dryRun: true };
    const result = await dispatchChatAction({ action: DISCOVER_CHAT_ACTION, params: input }, { registry, env: enabledEnv });
    expect(result).toMatchObject({ ok: true, status: "dispatched", action: DISCOVER_CHAT_ACTION });
    expect(result.result).toMatchObject({ ok: true, status: "executed", result: okResult });
    // Routed through the client that POSTs /api/discover -- never discover-cli.js directly.
    expect(requestDiscover).toHaveBeenCalledWith(input);
    expect(requestAttempt).not.toHaveBeenCalled();
  });

  it("forwards {} for a params-less discover rather than undefined", async () => {
    // The client always POSTs a JSON body; an undefined input would serialize as `undefined`, not `{}`.
    const { registry, requestDiscover } = setup();
    await dispatchChatAction({ action: DISCOVER_CHAT_ACTION }, { registry, env: enabledEnv });
    expect(requestDiscover).toHaveBeenCalledWith({});
  });

  it("runs attempt via the injected miner-ui client", async () => {
    const { registry, requestAttempt, requestDiscover } = setup();
    await dispatchChatAction({ action: ATTEMPT_CHAT_ACTION, params: attemptParams }, { registry, env: enabledEnv });
    expect(requestAttempt).toHaveBeenCalledWith(attemptParams);
    expect(requestDiscover).not.toHaveBeenCalled();
  });

  it("does not run either client when the shared action flag is off", async () => {
    const { registry, requestDiscover, requestAttempt } = setup();
    const result = await dispatchChatAction({ action: DISCOVER_CHAT_ACTION }, { registry, env: {} });
    expect(result).toMatchObject({ ok: false, status: "disabled" });
    expect(requestDiscover).not.toHaveBeenCalled();
    expect(requestAttempt).not.toHaveBeenCalled();
  });

  it("does not run attempt when params fail validation", async () => {
    const { registry, requestAttempt } = setup();
    const result = await dispatchChatAction(
      { action: ATTEMPT_CHAT_ACTION, params: { repoFullName: "acme/widgets" } },
      { registry, env: enabledEnv },
    );
    expect(result).toMatchObject({ ok: false, status: "invalid_params" });
    expect(requestAttempt).not.toHaveBeenCalled();
  });

  it("does not run the client when the gate denies", async () => {
    // The registry brand guarantees a gate runs first; a non-allow stage must short-circuit BEFORE the write.
    const { registry, requestAttempt } = setup({ evaluateGate: () => ({ decision: { stage: "deny" } }) });
    const result = await dispatchChatAction({ action: ATTEMPT_CHAT_ACTION, params: attemptParams }, { registry, env: enabledEnv });
    expect(result.result).toMatchObject({ ok: false, status: "gated", decision: { stage: "deny" } });
    expect(requestAttempt).not.toHaveBeenCalled();
  });
});
