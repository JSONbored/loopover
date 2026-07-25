// Allowlist registry + governor-gated handler contract for chat-issued miner actions (#6519).
//
// Shared scaffolding ONLY: this module ships with ZERO registered actions. The action families register their
// handlers into this registry -- none are added here, and the default `chatActionRegistry` instance starts
// empty. Governor pause/resume and discover/attempt register from packages/loopover-miner; portfolio
// release/requeue registers from apps/loopover-miner-ui (chat-portfolio-queue-actions.ts) under the
// `portfolio.release` / `portfolio.requeue` names -- #8640 deleted an orphaned duplicate of that family that
// had lived here in packages/loopover-miner under the divergent `portfolio_release` / `portfolio_requeue` names.
//
// The registration contract is the safety boundary. `register` refuses any handler that was not produced by
// `governorGatedHandler()`, and `governorGatedHandler()` routes every invocation through
// `evaluateGovernorChokepointGate` (packages/loopover-miner/lib/governor-chokepoint.js) and, through it, the
// fail-closed precedence ladder in packages/loopover-engine/src/governor/chokepoint.ts. Because a raw
// function can never be registered, a chat action can never perform a write on a path that bypasses the
// Governor chokepoint -- the contract enforces it structurally, not by review discipline. This module adds
// no second, competing safety check; it only forces every registered handler onto the existing one.

import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";

export type ChatActionRequest = {
  action?: string;
  params?: unknown;
  governorInput?: unknown;
};

/** A handler produced by {@link governorGatedHandler}; the only shape {@link ChatActionRegistry.register} accepts. */
export type GovernorGatedHandler = (request: ChatActionRequest) => Promise<Record<string, unknown>>;

export type ChatActionDefinition = {
  paramsValidator: (params: unknown) => boolean;
  handler: GovernorGatedHandler;
};

export type ChatActionEntry = {
  paramsValidator: (params: unknown) => boolean;
  handler: GovernorGatedHandler;
};

export type ChatActionRegistry = {
  register(name: string, definition: ChatActionDefinition): ChatActionEntry;
  get(name: string): ChatActionEntry | undefined;
  has(name: string): boolean;
  names(): string[];
  readonly size: number;
};

// Private brand. Not exported, so external code cannot forge a "gated" marker onto a raw function: the only
// way to obtain a handler that passes `isGovernorGatedHandler` is to build it through `governorGatedHandler`.
const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");

type GovernorGatedBrand = { [GOVERNOR_GATED]?: true };

type ChokepointGateResult = {
  decision?: { stage?: string } | null;
} | null | undefined;

/**
 * Wrap a local-write `run` function into a Governor-gated chat-action handler. The returned handler
 * evaluates the write against the full precedence ladder (via `evaluateGovernorChokepointGate`) BEFORE
 * running `run`, and only invokes `run` on a final `"allow"` verdict -- any other stage returns a gated
 * result and `run` never executes. This is the ONLY factory that produces a handler `register` accepts.
 */
export function governorGatedHandler(
  run: (request: ChatActionRequest, gate: unknown) => unknown,
  options: {
    evaluateGate?: (input: unknown, gateOptions?: unknown) => unknown;
    gateOptions?: unknown;
  } = {},
): GovernorGatedHandler {
  if (typeof run !== "function") {
    throw new TypeError("governorGatedHandler(run): run must be a function");
  }
  // Widen the default chokepoint evaluator to the registry's `unknown` input contract (chat requests carry
  // opaque governorInput); runtime still passes the same value through unchanged.
  const evaluateGate: (input: unknown, gateOptions?: unknown) => unknown =
    options.evaluateGate ?? (evaluateGovernorChokepointGate as (input: unknown, gateOptions?: unknown) => unknown);
  if (typeof evaluateGate !== "function") {
    throw new TypeError("governorGatedHandler: options.evaluateGate must be a function when supplied");
  }

  const handler = (async (request: ChatActionRequest): Promise<Record<string, unknown>> => {
    const gate = evaluateGate(request?.governorInput, options.gateOptions) as ChokepointGateResult;
    if (gate?.decision?.stage !== "allow") {
      return { ok: false, status: "gated", decision: gate?.decision ?? null };
    }
    const result = await run(request, gate);
    return { ok: true, status: "executed", decision: gate.decision, result };
  }) as GovernorGatedHandler & GovernorGatedBrand;
  Object.defineProperty(handler, GOVERNOR_GATED, { value: true });
  return handler;
}

/** True only for a handler produced by {@link governorGatedHandler}. */
export function isGovernorGatedHandler(handler: unknown): boolean {
  return typeof handler === "function" && (handler as GovernorGatedBrand)[GOVERNOR_GATED] === true;
}

/**
 * Build an isolated chat-action registry. Child issues register into the shared {@link chatActionRegistry};
 * this factory exists so tests (and any future multi-registry consumer) can register without polluting it.
 */
export function createChatActionRegistry(): ChatActionRegistry {
  const actions = new Map<string, ChatActionEntry>();

  function register(name: string, definition: ChatActionDefinition = {} as ChatActionDefinition): ChatActionEntry {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("registerChatAction(name): name must be a non-empty string");
    }
    if (actions.has(name)) {
      throw new Error(`registerChatAction: action "${name}" is already registered`);
    }
    const { paramsValidator, handler } = definition;
    if (typeof paramsValidator !== "function") {
      throw new TypeError(`registerChatAction("${name}"): paramsValidator must be a function`);
    }
    if (!isGovernorGatedHandler(handler)) {
      throw new Error(
        `registerChatAction("${name}"): handler must be produced by governorGatedHandler() so every ` +
          "chat-triggered write routes through governor-chokepoint.js -- a raw handler is rejected.",
      );
    }
    const entry: ChatActionEntry = { paramsValidator, handler };
    actions.set(name, entry);
    return entry;
  }

  return {
    register,
    get: (name) => actions.get(name),
    has: (name) => actions.has(name),
    names: () => [...actions.keys()],
    get size() {
      return actions.size;
    },
  };
}

/** The single shared registry the dispatch layer reads. Ships EMPTY (#6519); child issues register into it. */
export const chatActionRegistry: ChatActionRegistry = createChatActionRegistry();

/** Register a chat action on the shared {@link chatActionRegistry}. */
export function registerChatAction(name: string, definition: ChatActionDefinition): ChatActionEntry {
  return chatActionRegistry.register(name, definition);
}
