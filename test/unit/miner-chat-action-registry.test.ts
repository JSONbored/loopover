import { describe, expect, it, vi } from "vitest";

// governor-chokepoint.js (imported transitively by chat-action-registry.js) pulls in @loopover/engine, whose
// dist is not built in the test workspace -- resolve it against source, matching the sibling miner tests.
vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  chatActionRegistry,
  createChatActionRegistry,
  governorGatedHandler,
  isGovernorGatedHandler,
  registerChatAction,
} from "../../packages/loopover-miner/lib/chat-action-registry";

const allowGate = () => ({ decision: { stage: "allow" } });
const denyGate = () => ({ decision: { stage: "kill_switch" } });

describe("chat-action-registry (#6519)", () => {
  describe("governorGatedHandler", () => {
    it("marks its output as governor-gated and rejects a raw function", () => {
      const wrapped = governorGatedHandler(() => "written", { evaluateGate: allowGate });
      expect(isGovernorGatedHandler(wrapped)).toBe(true);
      expect(isGovernorGatedHandler(() => "written")).toBe(false);
      expect(isGovernorGatedHandler(null)).toBe(false);
    });

    it("throws when run is not a function", () => {
      // @ts-expect-error deliberately passing a non-function to exercise the guard
      expect(() => governorGatedHandler("nope")).toThrow(/run must be a function/);
    });

    it("throws when a supplied evaluateGate is not a function", () => {
      // @ts-expect-error deliberately passing a non-function gate
      expect(() => governorGatedHandler(() => {}, { evaluateGate: "nope" })).toThrow(/evaluateGate must be a function/);
    });

    it("runs the wrapped write only when the gate allows", async () => {
      const run = vi.fn(() => "did-write");
      const wrapped = governorGatedHandler(run, { evaluateGate: allowGate });
      const result = await wrapped({ governorInput: {} });
      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, status: "executed", decision: { stage: "allow" }, result: "did-write" });
    });

    it("returns a gated result and never runs the write when the gate denies", async () => {
      const run = vi.fn(() => "did-write");
      const wrapped = governorGatedHandler(run, { evaluateGate: denyGate });
      const result = await wrapped({ governorInput: {} });
      expect(run).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, status: "gated", decision: { stage: "kill_switch" } });
    });

    it("treats a gate result with no decision as denied (fail closed)", async () => {
      const run = vi.fn(() => "did-write");
      const wrapped = governorGatedHandler(run, { evaluateGate: () => undefined });
      const result = await wrapped({ governorInput: {} });
      expect(run).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, status: "gated", decision: null });
    });

    it("routes through the real evaluateGovernorChokepointGate by default", async () => {
      // No evaluateGate override: the handler falls back to the real governor-chokepoint.js wrapper, proving
      // the safety contract is wired to the actual precedence ladder, not just an injectable stub. A clean
      // input resolves to an `allow` stage; the ledger append is stubbed so the test stays side-effect-free.
      const run = vi.fn(() => "did-write");
      const wrapped = governorGatedHandler(run, { gateOptions: { append: (event: unknown) => ({ event }) } });
      const request = {
        governorInput: {
          actionClass: "open_pr",
          repoFullName: "acme/widgets",
          nowMs: 10_000,
          wouldBeAction: { action: "open_pr", title: "Fix bug" },
          killSwitchGlobal: false,
          killSwitchRepoPaused: false,
          liveModeGlobalOptIn: true,
          liveModeRepoOptIn: "live",
          rateLimitBuckets: { global: {}, perRepo: {} },
          rateLimitBackoffAttempts: {},
          capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 },
          capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
          convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
        },
      };
      const result = await wrapped(request);
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      expect(result.status).toBe("executed");
      expect((result.decision as { stage: string }).stage).toBe("allow");
      expect(result.result).toBe("did-write");
    });
  });

  describe("register", () => {
    const wrapped = governorGatedHandler(() => "ok", { evaluateGate: allowGate });

    it("accepts a governor-gated handler with a params-validator", () => {
      const registry = createChatActionRegistry();
      const entry = registry.register("demo", { paramsValidator: () => true, handler: wrapped });
      expect(registry.has("demo")).toBe(true);
      expect(registry.size).toBe(1);
      expect(registry.names()).toEqual(["demo"]);
      expect(registry.get("demo")).toBe(entry);
    });

    it("rejects a raw (unwrapped) handler at registration time", () => {
      const registry = createChatActionRegistry();
      expect(() =>
        registry.register("demo", {
          paramsValidator: () => true,
          handler: (() => "write") as unknown as ReturnType<typeof governorGatedHandler>,
        }),
      ).toThrow(/handler must be produced by governorGatedHandler/);
      expect(registry.size).toBe(0);
    });

    it("rejects a missing or non-function params-validator", () => {
      const registry = createChatActionRegistry();
      expect(() =>
        registry.register("demo", { handler: wrapped } as unknown as Parameters<typeof registry.register>[1]),
      ).toThrow(/paramsValidator must be a function/);
      expect(() =>
        registry.register("demo", { paramsValidator: "nope" as unknown as () => boolean, handler: wrapped }),
      ).toThrow(/paramsValidator must be a function/);
    });

    it("rejects an empty or non-string name", () => {
      const registry = createChatActionRegistry();
      expect(() => registry.register("", { paramsValidator: () => true, handler: wrapped })).toThrow(
        /name must be a non-empty string/,
      );
      expect(() =>
        registry.register("   ", { paramsValidator: () => true, handler: wrapped }),
      ).toThrow(/name must be a non-empty string/);
      expect(() =>
        registry.register(42 as unknown as string, { paramsValidator: () => true, handler: wrapped }),
      ).toThrow(/name must be a non-empty string/);
    });

    it("rejects a duplicate registration", () => {
      const registry = createChatActionRegistry();
      registry.register("demo", { paramsValidator: () => true, handler: wrapped });
      expect(() =>
        registry.register("demo", { paramsValidator: () => true, handler: wrapped }),
      ).toThrow(/already registered/);
    });
  });

  describe("shared registry", () => {
    it("REGRESSION: ships empty -- no action family is pre-registered in this scaffolding issue", () => {
      expect(chatActionRegistry.size).toBe(0);
      expect(chatActionRegistry.names()).toEqual([]);
    });

    it("exposes registerChatAction bound to the shared registry contract", () => {
      // Prove the convenience wrapper enforces the same handler contract without mutating the shared registry.
      expect(() =>
        registerChatAction("demo", {
          paramsValidator: () => true,
          handler: (() => "write") as unknown as ReturnType<typeof governorGatedHandler>,
        }),
      ).toThrow(/handler must be produced by governorGatedHandler/);
      expect(chatActionRegistry.size).toBe(0);
    });
  });
});
