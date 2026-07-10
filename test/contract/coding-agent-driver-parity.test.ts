// Behavioral contract/parity suite for the two `CodingAgentDriver` implementations (#4296): the CLI-subprocess
// driver (#4266, injected fake `CliSubprocessSpawnFn`) and the Agent-SDK driver (#4267, injected fake
// `AgentSdkQueryFn`). Unlike `engine-parity.test.ts` (golden-snapshot byte-parity for deterministic re-exports),
// a coding agent's output is NOT deterministic across implementations or runs — so this suite asserts the
// interchangeability CONTRACT instead: given equivalent backend behavior, both drivers accept the same
// `CodingAgentDriverTask` shape, scope execution to the task's working directory, forward the composed
// instructions verbatim, surface failures as structured results (never throws), and return the same
// `CodingAgentDriverResult` SHAPE — so the iterate-loop orchestrator (#2333) can swap one for the other with no
// caller-side changes.
//
// Adding a THIRD driver implementation later: append one entry to `DRIVER_HARNESSES` below that builds your
// driver around an injected fake backend able to express the three behaviors (`success`, `clean_failure`,
// `budget_exhausted`) and to record the working directory/prompt it was handed. Every contract case in this file
// then runs against it automatically — new drivers must not need any test-body changes, only a harness entry.
//
// Documented (deliberately tolerated) divergences the shared interface does NOT paper over — the contract is
// shape-level, not value-level (#4296's "close any interface gaps ... documented, not silently patched"):
// - `changedFiles`: the CLI driver always reports `[]` (post-hoc git-diff detection over the worktree is a
//   sibling concern, per its own header); the SDK driver reports the deduped Edit/Write/NotebookEdit tool-use
//   paths on success. The CONTRACT is: always a string array, and `[]` on any failed attempt.
// - `turnsUsed`: the CLI driver never reports a turn count (a subprocess exposes none); the SDK driver reports
//   `num_turns` when the stream's result frame carries one. The CONTRACT is: `number | undefined`.
// - budget exhaustion: the CLI driver's ceiling is wall-clock (`timedOut` -> `<command>_timeout_<ms>ms`); the
//   SDK driver's is the turn budget (`error_max_turns` -> `agent_sdk_error_max_turns`). The CONTRACT is:
//   `ok: false` with a non-empty machine-readable `error`, never a throw.

import { describe, expect, it } from "vitest";
import {
  createAgentSdkCodingAgentDriver,
  createCliSubprocessCodingAgentDriver,
  invokeCodingAgentDriver,
  type AttemptLogEvent,
  type CodingAgentDriver,
  type CodingAgentDriverResult,
  type CodingAgentDriverTask,
} from "../../packages/gittensory-engine/src/index";

// One shared worktree path across every describe.each iteration ON PURPOSE: harness isolation comes from each
// case calling `make()` for a fresh driver + recorder, not from unique paths — reusing the constant keeps the
// scoping assertions comparable across drivers.
const WORKTREE = "/tmp/worktrees/attempt-parity-1";

const task: CodingAgentDriverTask = {
  attemptId: "attempt-parity-1",
  workingDirectory: WORKTREE,
  acceptanceCriteriaPath: `${WORKTREE}/ACCEPTANCE-CRITERIA.md`,
  instructions: "Implement the fix described in ACCEPTANCE-CRITERIA.md.",
  maxTurns: 6,
};

// The #4271 edge case: a malformed/empty acceptance-criteria input must degrade to a structured result on both
// implementations, never a throw.
const emptyCriteriaTask: CodingAgentDriverTask = {
  attemptId: "attempt-parity-empty",
  workingDirectory: WORKTREE,
  acceptanceCriteriaPath: "",
  instructions: "",
  maxTurns: 1,
};

type Behavior = "success" | "clean_failure" | "budget_exhausted";

/** What a harness records about the backend invocation, for the scoping/input-forwarding contract cases. */
type RecordedInvocation = {
  /** Every working directory the backend was pointed at — the scoping contract requires exactly the task's. */
  cwds: string[];
  /** The instructions/prompt text the backend received — must be the task's, verbatim, un-reframed. */
  prompts: string[];
};

type DriverHarness = {
  name: string;
  make: (behavior: Behavior) => { driver: CodingAgentDriver; recorded: RecordedInvocation };
};

const DRIVER_HARNESSES: DriverHarness[] = [
  {
    name: "cli-subprocess (#4266)",
    make: (behavior) => {
      const recorded: RecordedInvocation = { cwds: [], prompts: [] };
      const driver = createCliSubprocessCodingAgentDriver({
        command: "claude",
        spawn: async (_cmd, args, opts) => {
          recorded.cwds.push(opts.cwd);
          // Capture EVERY argv element (not a positional assumption about where the instructions land): if the
          // driver's argv-building order ever changes, the contains-assertion below fails loudly instead of
          // silently checking the wrong argument.
          recorded.prompts.push(...args.map(String));
          if (behavior === "budget_exhausted") return { stdout: "partial output", code: null, timedOut: true };
          if (behavior === "clean_failure") return { stdout: "", code: 1, stderr: "lint failed on src/a.ts" };
          return { stdout: "edited src/a.ts and reran the suite", code: 0 };
        },
      });
      return { driver, recorded };
    },
  },
  {
    name: "agent-sdk (#4267)",
    make: (behavior) => {
      const recorded: RecordedInvocation = { cwds: [], prompts: [] };
      const driver = createAgentSdkCodingAgentDriver({
        query: (input) => {
          recorded.cwds.push(input.options.cwd);
          recorded.prompts.push(input.prompt);
          return (async function* (): AsyncGenerator<Record<string, unknown>> {
            if (behavior === "budget_exhausted") {
              yield { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 6 };
              return;
            }
            if (behavior === "clean_failure") {
              yield { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 2 };
              return;
            }
            yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } };
            yield { type: "result", subtype: "success", is_error: false, num_turns: 3, result: "edited src/a.ts" };
          })();
        },
      });
      return { driver, recorded };
    },
  },
];

/** The #4262 result contract, field by field — identical SHAPE requirements for every implementation. */
function expectDriverResultShape(result: CodingAgentDriverResult): void {
  expect(typeof result.ok).toBe("boolean");
  expect(Array.isArray(result.changedFiles)).toBe(true);
  for (const file of result.changedFiles) expect(typeof file).toBe("string");
  expect(typeof result.summary).toBe("string");
  expect(result.summary.length).toBeGreaterThan(0);
  if (result.transcript !== undefined) expect(typeof result.transcript).toBe("string");
  if (result.turnsUsed !== undefined) expect(typeof result.turnsUsed).toBe("number");
  if (result.error !== undefined) {
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  }
}

describe.each(DRIVER_HARNESSES)("CodingAgentDriver contract — $name", ({ make }) => {
  it("returns the shared result shape with ok=true and no error on a successful attempt", async () => {
    const { driver } = make("success");
    const result = await driver.run(task);
    expectDriverResultShape(result);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("surfaces a clean failure as a structured result (never a throw) with [] changed files", async () => {
    const { driver } = make("clean_failure");
    const result = await driver.run(task);
    expectDriverResultShape(result);
    expect(result.ok).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("surfaces budget exhaustion (wall-clock or turn budget) the same structured way", async () => {
    const { driver } = make("budget_exhausted");
    const result = await driver.run(task);
    expectDriverResultShape(result);
    expect(result.ok).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("scopes every backend invocation to the task's working directory and nothing else (#4269 output)", async () => {
    const { driver, recorded } = make("success");
    await driver.run(task);
    expect(recorded.cwds.length).toBeGreaterThan(0);
    for (const cwd of recorded.cwds) expect(cwd).toBe(WORKTREE);
  });

  it("forwards the composed instructions verbatim — no driver-side prompt reframing", async () => {
    const { driver, recorded } = make("success");
    await driver.run(task);
    expect(recorded.prompts).toContain(task.instructions);
  });

  it("keeps failure-path summaries distinguishable from success-path summaries", async () => {
    const success = await make("success").driver.run(task);
    const failure = await make("clean_failure").driver.run(task);
    expect(success.summary).not.toBe(failure.summary);
  });

  it("degrades a malformed/empty acceptance-criteria input (#4271) to a structured result, never a throw", async () => {
    const { driver } = make("success");
    const result = await driver.run(emptyCriteriaTask);
    expectDriverResultShape(result);
  });
});

describe("caller-side interchangeability (#2333's requirement)", () => {
  it("produces the same attempt-log event sequence through invokeCodingAgentDriver for both drivers", async () => {
    const sequences: string[][] = [];
    for (const harness of DRIVER_HARNESSES) {
      const events: AttemptLogEvent[] = [];
      const { driver } = harness.make("success");
      const result = await invokeCodingAgentDriver(driver, "live", task, { append: (event) => events.push(event) });
      expect(result.ok).toBe(true);
      sequences.push(events.map((event) => event.eventType));
    }
    expect(sequences[0]).toEqual(["attempt_started", "attempt_succeeded"]);
    expect(sequences[1]).toEqual(sequences[0]);
  });

  it("produces the same attempt-log failure sequence for both drivers", async () => {
    const sequences: string[][] = [];
    for (const harness of DRIVER_HARNESSES) {
      const events: AttemptLogEvent[] = [];
      const { driver } = harness.make("clean_failure");
      const result = await invokeCodingAgentDriver(driver, "live", task, { append: (event) => events.push(event) });
      expect(result.ok).toBe(false);
      sequences.push(events.map((event) => event.eventType));
    }
    expect(sequences[0]).toEqual(["attempt_started", "attempt_failed"]);
    expect(sequences[1]).toEqual(sequences[0]);
  });
});

describe("documented divergences, locked in explicitly", () => {
  it("CLI driver reports no turn count (a subprocess exposes none) — turnsUsed stays undefined", async () => {
    const { driver } = DRIVER_HARNESSES[0]!.make("success");
    const result = await driver.run(task);
    expect(result.turnsUsed).toBeUndefined();
  });

  it("Agent-SDK driver reports the result frame's num_turns", async () => {
    const { driver } = DRIVER_HARNESSES[1]!.make("success");
    const result = await driver.run(task);
    expect(result.turnsUsed).toBe(3);
  });
});
