# @loopover/contract

The single zod source of truth for LoopOver's MCP tool and API contracts.

LoopOver runs three MCP servers — the hosted/self-host remote server (`src/mcp/server.ts`), the
stdio contributor wrapper (`@loopover/mcp`), and the AMS miner server (`@loopover/miner`) — plus a
REST API and a UI that all describe the same data. Before this package, each of those declared its
own zod shapes, and the copies drifted: the stdio server's shapes were hand-mirrored from the remote
server's (their own comments said so), enum literals were hand-copied out of the engine, and
responses were consumed as `any`.

This package is the one place those contracts live. **A shape declared here is never restated
elsewhere.**

## Why a separate package

It is a **leaf**: its only runtime dependency is `zod`, and it imports no node builtins, so it is
safe in the Cloudflare Workers bundle. That is what lets every surface depend on it — the Worker,
both published stdio bins, the miner, the control plane, and the UI — without dragging the engine
along behind it. Sharing these schemas through `@loopover/engine` was considered and rejected:
`@loopover/mcp` resolves the engine through its *published* export map, which never surfaced the
enums, so importing them would have meant widening the engine's public API (#6153).

## Layout

| Path | Holds |
|---|---|
| `src/tool-definition.ts` | The `ToolContract` model, `defineTool`, and `projectToolDefinitions` — the single projection point |
| `src/tools/*.ts` | One file per tool family; the contracts themselves |
| `src/tools/index.ts` | `TOOL_CONTRACTS`, `listToolDefinitions()`, `getToolContract()` |
| `src/enums.ts` | Shared enum vocabularies (autonomy levels, action classes, …) |
| `src/shared.ts` | Shapes reused by **three or more** contracts |
| `src/agent-specs.ts` | OpenAI / Anthropic / agent-index projections |

## Conventions

These are enforced by meta-tests in `test/unit/contract-registry.test.ts`, not just documented.

**Naming.** One file per tool family. Within it, export `<ToolNamePascal>Input` and
`<ToolNamePascal>Output` schemas plus the `defineTool(...)` contract. Derive types with
`z.infer<typeof X>` — never hand-write an interface that mirrors a schema.

**Inputs are closed; outputs are open.** Input schemas use `z.object`, which emits
`additionalProperties: false`. Output schemas use `z.looseObject`, which emits open
`additionalProperties`. An MCP output schema is a *floor*, not a fence: a server that starts
returning an extra field must not retroactively invalidate a client validating against the older
schema.

> **Known gap:** zod's `z.object` *strips* unknown keys at runtime rather than rejecting them, so a
> typo'd argument is silently dropped even though the advertised JSON Schema says it should be
> refused. Switching to `z.strictObject` would close the gap but is a wire-visible tightening, so it
> is a recorded decision on #9518 rather than a drive-by change. A meta-test pins the current
> behavior so the switch cannot happen by accident.

**Output schemas may be shallower than their REST counterparts, and that is deliberate.** Reusing a
strict REST response schema for an MCP tool *tightens* the wire contract and is a regression — the
exact constraint metagraphed hit during its own migration. Reuse a REST schema only when it is
field-for-field equal to what the tool actually returns. What is never acceptable is a top-level
`z.unknown()` standing in for a real object.

**Hoist to `shared.ts` at the third consumer, not the second.** Two contracts sharing fields today
is usually coincidence; coupling them early means a later divergence has to be un-shared under
pressure.

**Metadata is a declaration, not a hint.** Every contract states its `auth`, `locality`, and
`availability`, and runtimes enforce them:

- `locality` — where the state physically lives (`remote`, `local-git`, `miner`). This is why
  LoopOver cannot collapse to one MCP process: `local-git` tools read the caller's uncommitted
  working tree and `miner` tools read the miner box's stores, neither reachable from a Worker.
- `availability` — `cloud`, `selfhost`, or `both`. Self-host-only tools depend on capabilities the
  Workers bundle cannot provide (fs-backed config, a redeploy socket).
- `auth` — the identity kind `src/auth/security.ts` must authenticate before the tool runs.

**Nothing reads `TOOL_CONTRACTS` directly.** Consumers call `listToolDefinitions()` (optionally
filtered), so cross-cutting concerns are applied exactly once.

## Adding a tool

1. Add `src/tools/<family>.ts` with input + output schemas and a `defineTool(...)` entry.
2. Export it from `src/tools/index.ts`.
3. Register it in whichever runtimes can serve its locality, using `contract.input.shape` /
   `contract.output.shape` for the MCP SDK.
4. The contract validator (#9520) requires a smoke call per tool — a tool with no call fails CI.

Generated docs, agent tool specs, and the tool-reference tables pick it up automatically. If you
find yourself hand-editing a tool table, that table is a bug.
