// Agent-SDK `CodingAgentDriver` (#4267): the second implementation of the #4262 seam, driving the coding agent
// in-process via `@anthropic-ai/claude-agent-sdk`'s `query()` async-iterable loop instead of shelling out to a CLI
// binary (#4266). The streamed SDK message/tool-use events are folded into the shared `CodingAgentDriverResult`
// right here — no SDK-specific event type leaks into the interface, so the iterate-loop orchestrator (#2333) can
// swap this driver for the CLI-subprocess one with no caller-side changes.
//
// The SDK session's hook surface is deliberately NOT encapsulated: callers pass `hooks` (e.g. a `PreToolUse`
// matcher, #2343's stated attachment point) and this driver forwards them verbatim onto the `query()` options, so
// house-rule enforcement can intercept every tool call before execution without this module knowing the rules.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { redactSecrets } from "../subprocess-env.js";
import type {
  CodingAgentDriver,
  CodingAgentDriverResult,
  CodingAgentDriverTask,
  CodingAgentTokenUsage,
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
  allowedTools: readonly string[];
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

const execFileAsync = promisify(execFile);

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
  /** Injected changed-file enumerator; defaults to git diff over the worktree. */
  listChangedFiles?: ((cwd: string) => Promise<string[]>) | undefined;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** A finite, non-negative number, else undefined — mirrors `cli-subprocess-driver.ts`'s helper of the same name
 *  so both drivers reject the same out-of-contract usage values (`NaN`, `Infinity`, negatives) from untrusted
 *  driver output. A malformed value degrades to the driver's existing "field absent" contract (undefined) rather
 *  than propagating downstream, where `attempt-metering.ts`'s accumulateAttemptUsage would throw a RangeError and
 *  reject the whole iterate loop before its decision is ever logged (#5827). */
function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Real token count from the SDK's own result message (#5653). Both `SDKResultSuccess` and `SDKResultError`
 *  declare `usage: NonNullableUsage` unconditionally -- present whenever a result message arrived at all, same
 *  as `total_cost_usd`. `NonNullableUsage`'s `input_tokens`/`output_tokens` are themselves non-nullable numbers
 *  once `usage` exists, but this driver reads `resultMessage` as a loosely-typed record (like every other field
 *  read here), so both are re-validated defensively (finite + non-negative, #5827) rather than trusted from an
 *  untyped source. Returns an EMPTY usage (never a fabricated 0) when `usage` is absent or malformed.
 *
 *  #10198: returns the split alongside the blended total rather than only the sum. Both sides were already read
 *  here and then added together, discarding the parts -- which left the miner with nothing to put in PostHog's
 *  own `$ai_input_tokens`/`$ai_output_tokens`, the properties its cost views read. Each field is omitted rather
 *  than zeroed when the provider did not report it: a fabricated 0 is indistinguishable from a real one in an
 *  aggregate. */
function tokensFromResultMessage(resultMessage: Record<string, unknown> | null): CodingAgentTokenUsage {
  const usage = asRecord(resultMessage?.usage);
  const inputTokens = finiteNonNegativeNumber(usage?.input_tokens);
  const outputTokens = finiteNonNegativeNumber(usage?.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return {};
  return {
    tokensUsed: (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

async function listWorktreeChangedFiles(cwd: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    execFileAsync("git", ["-C", cwd, "diff", "--name-only", "HEAD", "--"]),
    execFileAsync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard"]),
  ]);
  return Array.from(
    new Set(
      [tracked.stdout, untracked.stdout]
        .join("\n")
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter(Boolean),
    ),
  );
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
      if (typeof filePath === "string") changedFiles.add(filePath);
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
  const listChangedFiles = options.listChangedFiles ?? listWorktreeChangedFiles;

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
            // Match the CLI-subprocess driver's headless permission scope (#4266, #6840): `acceptEdits` auto-
            // approves file EDIT tool calls inside the scoped worktree, but does NOT grant `Read` or `Bash` — a
            // real task needs both to explore the repo and run tests, so without an explicit allowlist every such
            // call was denied and the driver silently produced zero work. Grant exactly `Read` + `Bash` (the CLI's
            // `--allowedTools Read Bash`), nothing broader; `bypassPermissions` would drop every other safety rail.
            permissionMode: "acceptEdits",
            allowedTools: ["Read", "Bash"],
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

      // finiteNonNegativeNumber (not a bare typeof check): a malformed num_turns/total_cost_usd (NaN, Infinity,
      // negative) must degrade to undefined here, or it reaches accumulateAttemptUsage unguarded and throws a
      // RangeError that rejects runIterateLoopCore before any decision is logged (#5827).
      const turnsUsed = finiteNonNegativeNumber(resultMessage?.num_turns);
      // Real dollar cost: the SDK's own SDKResultSuccess/SDKResultError message types both declare
      // `total_cost_usd: number` unconditionally -- present whenever a result message arrived at all, success
      // or not (the session was billed either way), absent only when the stream produced no result message.
      const costUsd = finiteNonNegativeNumber(resultMessage?.total_cost_usd);
      const tokenUsage = tokensFromResultMessage(resultMessage);
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
          costUsd,
          ...tokenUsage,
          error: `agent_sdk_${subtype === "success" ? "errored" : subtype}`,
        };
      }

      let worktreeChangedFiles: string[];
      try {
        worktreeChangedFiles = await listChangedFiles(task.workingDirectory);
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, MAX_REDACTED_TEXT_LENGTH);
        return {
          ok: false,
          changedFiles: [],
          summary: "agent sdk changed-file enumeration failed",
          transcript,
          turnsUsed,
          costUsd,
          ...tokenUsage,
          error: `agent_sdk_changed_files_unavailable: ${detail}`,
        };
      }

      const allChangedFiles = Array.from(new Set([...changedFiles, ...worktreeChangedFiles]));
      return {
        ok: true,
        changedFiles: allChangedFiles,
        summary: resultText.slice(0, MAX_REDACTED_TEXT_LENGTH) || `coding agent completed with ${allChangedFiles.length} changed file(s)`,
        transcript,
        turnsUsed,
        costUsd,
        ...tokenUsage,
      };
    },
  };
}
