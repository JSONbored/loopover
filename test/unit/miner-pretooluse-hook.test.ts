import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHouseRulesPreToolUseHook } from "../../packages/gittensory-miner/lib/pretooluse-hook.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";

// The live Agent SDK PreToolUse interception point (#2343). deny-hooks.js's own rule logic (matcher, glob,
// path-tokenizing, force-push detection) is already exhaustively tested in miner-deny-hooks.test.ts — these
// tests cover only this wrapper's own job: translating the real hook input shape, returning the exact
// SDK-documented deny/allow output shape, recording denials to the governor ledger, and failing closed.
//
// NOTE on "enforced even under bypassPermissions": the Agent SDK's own documented permission-evaluation order
// runs hooks BEFORE the permission-mode check, and its docs state plainly that hook denials still apply in
// bypassPermissions mode. That guarantee is the SDK's responsibility, not this module's -- it cannot be
// exercised by a unit test here without a live SDK session. What IS this module's responsibility, and what
// these tests cover, is returning a correctly-shaped deny every time, regardless of mode.

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-pretooluse-hook-"));
  roots.push(root);
  const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

describe("buildHouseRulesPreToolUseHook (#2343)", () => {
  it("allows a tool call matching no house rule, returning an empty object unmodified", async () => {
    const hook = buildHouseRulesPreToolUseHook();
    const result = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "src/index.ts" },
    });
    expect(result).toEqual({});
  });

  it("denies a tool call matching a house rule, in the exact SDK-documented hookSpecificOutput shape", async () => {
    const hook = buildHouseRulesPreToolUseHook();
    const result = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: ".env" },
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("environment files"),
      },
    });
  });

  it("records every denial to the governor ledger with the specific rule's reason", async () => {
    const ledger = openLedger();
    const hook = buildHouseRulesPreToolUseHook(
      { repoFullName: "acme/widgets" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force" } });

    const rows = ledger.readGovernorEvents({ repoFullName: "acme/widgets" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionClass).toBe("pretooluse_hook");
    expect(rows[0]?.decision).toBe("deny");
    expect(rows[0]?.reason).toContain("force-push");
    expect(rows[0]?.payload).toMatchObject({ toolName: "Bash" });
  });

  it("does not record anything to the ledger for an allowed tool call", async () => {
    const ledger = openLedger();
    const append = vi.fn((event: Parameters<typeof ledger.appendGovernorEvent>[0]) => ledger.appendGovernorEvent(event));
    const hook = buildHouseRulesPreToolUseHook({}, { append });

    await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "README.md" } });

    expect(append).not.toHaveBeenCalled();
  });

  it("accepts a caller-supplied effective rule set instead of the built-in defaults", async () => {
    const hook = buildHouseRulesPreToolUseHook({
      rules: [{ matcher: "*", pathPattern: "**/custom-blocked.txt", reason: "Custom house rule." }],
    });

    const denied = await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "custom-blocked.txt" } });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });

    // A path that only the BUILT-IN defaults would block is allowed here, proving the custom set replaced
    // (not merged with) the defaults -- composition is the caller's job (e.g. resolveEffectiveDenyRules).
    const allowed = await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: ".env" } });
    expect(allowed).toEqual({});
  });

  it("fails closed: an internal error while evaluating rules denies rather than silently allowing", async () => {
    // A rule whose `matcher` property throws when accessed forces a genuine exception through the real
    // evaluateDenyHooks call, exercising the wrapper's own catch-all without needing a test-only seam in
    // production code.
    const throwingRule = new Proxy(
      {},
      {
        get() {
          throw new Error("synthetic rule access failure");
        },
      },
    );
    const hook = buildHouseRulesPreToolUseHook({ rules: [throwingRule as never] });

    const result = await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "anything.ts" } });

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("pretooluse_hook_internal_error"),
      },
    });
  });

  it("fails closed even when the governor ledger append itself throws", async () => {
    const throwingAppend = () => {
      throw new Error("ledger unavailable");
    };
    const hook = buildHouseRulesPreToolUseHook({}, { append: throwingAppend });

    const result = await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: ".env" } });

    // The tool call is still denied even though the audit write failed -- a logging outage must never
    // downgrade a security decision to allow.
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});
