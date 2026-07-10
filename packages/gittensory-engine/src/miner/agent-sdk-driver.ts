// Agent-SDK `CodingAgentDriver` (#4267): the second implementation of the #4262 seam, driving the coding agent
// in-process via `@anthropic-ai/claude-agent-sdk`'s `query()` async-iterable loop instead of shelling out to a CLI
// binary (#4266). The streamed SDK message/tool-use events are folded into the shared `CodingAgentDriverResult`
// right here — no SDK-specific event type leaks into the interface, so the iterate-loop orchestrator (#2333) can
// swap this driver for the CLI-subprocess one with no caller-side changes.
//
// The SDK session's hook surface is deliberately NOT encapsulated: callers pass `hooks` (e.g. a `PreToolUse`
// matcher, #2343's stated attachment point) and this driver forwards them verbatim onto the `query()` options, so
// house-rule enforcement can intercept every tool call before execution without this module knowing the rules.

import { redactSecrets } from "../subprocess-env.js";
import type {
  CodingAgentDriver,
  CodingAgentDriverResult,
  CodingAgentDriverTask,
} from "./coding-agent-driver.js";

/**
 * Opaque hook registration forwarded verbatim to the SDK session (`Options['hooks']` — keyed by hook event name,
 * e.g. `PreToolUse`). Typed loosely on purpose: the hook contract belongs to the SDK and to the policy module that
 * registers the hooks, not to this driver.
 */
export type AgentSdkHooks = Record<string, unknown>;

/** The exact option subset this driver puts on a `query()` session. */
export type AgentSdkQueryOptions = {
  cwd: string;
  maxTurns: number;
  permissionMode: "acceptEdits";
  hooks?: AgentSdkHooks | undefined;
};

/**
 * Injected `query()`-shaped function — mirrors the injected-`SpawnFn` testability convention from #4262/#4266 so
 * tests drive the driver with a fake async-iterable and CI never makes a real model call. Messages are consumed
 * structurally (plain records), matching how the defensive fold below reads them.
 */
export type AgentSdkQueryFn = (input: {
  prompt: string;
  options: AgentSdkQueryOptions;
}) => AsyncIterable<Record<string, unknown>>;

/** Tool names whose successful use means a file in the working directory changed. */
const FILE_EDIT_TOOL_NAMES = new Set(["Edit", "Write", "NotebookEdit"]);

/** Ceiling for any redacted free text surfaced on the result (error detail, summary) — one named place. */
const MAX_REDACTED_TEXT_LENGTH = 500;

/* v8 ignore start -- real-SDK path: imports @anthropic-ai/claude-agent-sdk and spawns a live session; tests
   inject a fake AgentSdkQueryFn instead (same convention as the CLI driver's injected SpawnFn). */
const defaultQuery: AgentSdkQueryFn = (input) => {
  async function* stream(): AsyncGenerator<Record<string, unknown>> {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
      query: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
    };
    for await (const message of sdk.query({ prompt: input.prompt, options: input.options })) {
      yield message as Record<string, unknown>;
    }
  }
  return stream();
};
/* v8 ignore stop */

export type CreateAgentSdkDriverOptions = {
  /** Injected `query()` loop; defaults to the real `@anthropic-ai/claude-agent-sdk` export. */
  query?: AgentSdkQueryFn | undefined;
  /** Forwarded verbatim to the SDK session — the #2343 `PreToolUse` interception point. */
  hooks?: AgentSdkHooks | undefined;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Fold one assistant message's content blocks into the transcript/changed-file accumulators. */
function foldAssistantMessage(
  message: Record<string, unknown>,
  transcript: string[],
  changedFiles: Set<string>,
): void {
  const content = asRecord(message.message)?.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      transcript.push(block.text);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const filePath = asRecord(block.input)?.file_path;
      if (FILE_EDIT_TOOL_NAMES.has(block.name) && typeof filePath === "string") {
        changedFiles.add(filePath);
      }
    }
  }
}

/**
 * A `CodingAgentDriver` that runs the attempt through an in-process Agent-SDK `query()` session in the task's
 * working directory. Mirrors the CLI-subprocess driver's contract: structured failure results (never a throw),
 * `changedFiles` reported only on success (the CLI driver cannot know them on failure, and #4296's parity suite
 * holds both implementations to the same shape), and `task.instructions` forwarded verbatim as the prompt — the
 * acceptance-criteria document already lives inside the worktree at `task.acceptanceCriteriaPath` (#4271).
 */
export function createAgentSdkCodingAgentDriver(
  options: CreateAgentSdkDriverOptions = {},
): CodingAgentDriver {
  const query = options.query ?? defaultQuery;

  return {
    async run(task: CodingAgentDriverTask): Promise<CodingAgentDriverResult> {
      const transcriptParts: string[] = [];
      const changedFiles = new Set<string>();
      let resultMessage: Record<string, unknown> | null = null;

      try {
        const stream = query({
          prompt: task.instructions,
          options: {
            cwd: task.workingDirectory,
            maxTurns: task.maxTurns,
            // Same edit-permission scope as the CLI-subprocess driver (#4266): `--permission-mode acceptEdits`
            // there, `acceptEdits` here — file edits run unattended inside the scoped worktree, nothing broader.
            permissionMode: "acceptEdits",
            hooks: options.hooks,
          },
        });
        for await (const message of stream) {
          if (message.type === "assistant") {
            foldAssistantMessage(message, transcriptParts, changedFiles);
          } else if (message.type === "result") {
            resultMessage = message;
          }
        }
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, MAX_REDACTED_TEXT_LENGTH);
        return {
          ok: false,
          changedFiles: [],
          summary: "agent sdk session threw",
          transcript: redactSecrets(transcriptParts.join("\n")),
          error: `agent_sdk_thrown: ${detail}`,
        };
      }

      const turnsUsed =
        typeof resultMessage?.num_turns === "number" ? resultMessage.num_turns : undefined;
      const resultText =
        typeof resultMessage?.result === "string" ? redactSecrets(resultMessage.result) : "";
      const transcript = redactSecrets(
        [...transcriptParts, ...(resultText ? [resultText] : [])].join("\n"),
      );

      // A stream that ends without a `result` frame is a protocol failure, not a silent success.
      if (!resultMessage) {
        return {
          ok: false,
          changedFiles: [],
          summary: "agent sdk stream ended without a result message",
          transcript,
          error: "agent_sdk_no_result",
        };
      }

      if (resultMessage.subtype !== "success" || resultMessage.is_error === true) {
        const subtype = typeof resultMessage.subtype === "string" ? resultMessage.subtype : "unknown";
        return {
          ok: false,
          changedFiles: [],
          summary: "agent sdk session did not complete successfully",
          transcript,
          turnsUsed,
          error: `agent_sdk_${subtype === "success" ? "errored" : subtype}`,
        };
      }

      return {
        ok: true,
        changedFiles: [...changedFiles],
        summary: resultText.slice(0, MAX_REDACTED_TEXT_LENGTH) || `coding agent completed with ${changedFiles.size} changed file(s)`,
        transcript,
        turnsUsed,
      };
    },
  };
}
