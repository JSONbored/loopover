import { Octokit } from "@octokit/core";
import { isGlobalAgentFrozen, recordAuditEvent } from "../db/repositories";
import { isGlobalAgentPause, resolveAgentActionMode, type AgentActionMode } from "../settings/agent-execution";
import type { RepositorySettings } from "../types";

// The SINGLE place an installation-scoped Octokit is built. Every GitHub write in src/github/** routes through
// makeInstallationOctokit; when the repo's action mode is not "live" a request hook SUPPRESSES every
// state-changing verb (POST/PATCH/PUT/DELETE) — auditing the intent and returning a route-shaped synthetic
// response — so NO mutation reaches GitHub during a dry-run / pause / global freeze. GET/HEAD always pass through
// (pure reads + the load-bearing create-vs-update / dedup probes). This makes "no mutation unless live" a
// STRUCTURAL invariant rather than a per-call convention; test/unit/no-direct-octokit.test.ts forbids a raw
// `new Octokit` anywhere else in src/github/**. (#dry-run-chokepoint)
//
// Scope note: this governs INSTALLATION-token Octokit writes only. A few paths write via raw fetch() with
// non-installation tokens (upstream drift issues, contributor-issue drafts, end-user fork drafting) and are NOT
// covered here — they carry their own mode guard / are a separate actor class.

const GITHUB_FETCH_TIMEOUT_MS = 12_000;

// A 12s hard cap on every GitHub request. Centralised here so the comment / label / pr-action helpers — which
// previously built a bare `new Octokit({ auth })` with no cap — all inherit the bound for free.
export function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.signal) return fetch(input, init);
  return fetch(input, { ...(init ?? {}), signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
}

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Resolve a repo's agent action mode the SAME way the executor does: the env emergency brake OR the DB global
 * freeze OR the per-repo pause/dry-run. Call this ONCE per review and thread the result into every surface write
 * — it performs one isGlobalAgentFrozen() read, so it must never sit on a per-write hot path.
 */
export async function resolveRepoActionMode(env: Env, settings: Pick<RepositorySettings, "agentPaused" | "agentDryRun"> | null | undefined): Promise<AgentActionMode> {
  return resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
    agentPaused: settings?.agentPaused,
    agentDryRun: settings?.agentDryRun,
  });
}

// A route-shaped synthetic response for a SUPPRESSED write, so every mutation-response reader survives a dry-run:
//  - check-runs: id MUST be truthy AND !== undefined (app.ts tests `if (checkRunId)`, processors test `!== undefined`).
//    -1 satisfies both; 0 would be falsy and is forbidden. The follow-up completion PATCH it feeds is also suppressed.
//  - comments: { id:-1, html_url:"" } — callers read id?.??null / Boolean(id) and tolerate any value.
//  - reviews: { id:-1 } — the executor reads nothing, it only must not throw.
//  - merge (PUT): { merged:true, sha:null } — no reader; a non-throw records the action as a completed shadow.
//  - everything else (labels, update-branch, close, reactions): {} — no reader.
function syntheticWriteResponse(url: string): { status: number; url: string; headers: Record<string, string>; data: unknown } {
  const base = { status: 200, url, headers: {} as Record<string, string> };
  if (/\/check-runs(\/|$|\?)/.test(url)) return { ...base, data: { id: -1, dryRunSuppressed: true } };
  if (/\/comments(\/|$|\?)/.test(url)) return { ...base, data: { id: -1, html_url: "", dryRunSuppressed: true } };
  if (/\/reviews(\/|$|\?)/.test(url)) return { ...base, data: { id: -1, dryRunSuppressed: true } };
  if (/\/merge(\/|$|\?)/.test(url)) return { ...base, data: { merged: true, sha: null, dryRunSuppressed: true } };
  return { ...base, data: { dryRunSuppressed: true } };
}

/**
 * Instance-wide self-host kill switch (#selfhost-deployment-mode). SELFHOST_DEPLOYMENT_MODE=dry-run|disabled
 * forces write suppression for the WHOLE instance regardless of the per-call mode — so a self-host running in
 * PARALLEL with the live cloud App can receive the same webhooks but provably post NOTHING (no check-run /
 * comment / label / merge) until an explicit cutover, without relying on every call site threading the repo mode.
 * Unset (the cloud Worker never sets it) → null → behavior is byte-identical to today.
 */
export function forcedSelfhostMode(env: { SELFHOST_DEPLOYMENT_MODE?: string | undefined }): AgentActionMode | null {
  const m = (env.SELFHOST_DEPLOYMENT_MODE ?? "").trim().toLowerCase();
  if (m === "disabled") return "paused"; // suppress + audit as denied
  if (m === "dry-run" || m === "dry_run") return "dry_run"; // suppress + audit as completed-shadow
  return null; // "live" / unset → no forcing
}

/**
 * Build an installation Octokit from an ALREADY-minted token. Takes the token (not the installationId) so this
 * module never imports createInstallationToken — the mint stays in app.ts via raw fetch and can never be reached
 * by the suppression hook. `mode` defaults to "live", so the action helpers (pr-actions) that are already gated by
 * the executor are not double-denied; surface callers (check-run / comment / label) pass the resolved repo mode.
 * A SELFHOST_DEPLOYMENT_MODE override beats the per-call mode so the whole instance can be forced non-actuating.
 */
export function makeInstallationOctokit(env: Env, token: string, mode: AgentActionMode = "live"): Octokit {
  const octokit = new Octokit({ auth: token, request: { fetch: timeoutFetch } });
  const effectiveMode = forcedSelfhostMode(env) ?? mode;
  if (effectiveMode !== "live") {
    octokit.hook.wrap("request", async (request, options) => {
      const method = options.method.toUpperCase();
      if (!WRITE_METHODS.has(method)) return request(options); // reads + create-vs-update probes always run
      const url = options.url;
      await recordAuditEvent(env, {
        eventType: "github.write.suppressed",
        actor: "gittensory",
        targetKey: url,
        outcome: effectiveMode === "dry_run" ? "completed" : "denied",
        detail: `${effectiveMode}: suppressed ${method} ${url}`,
        metadata: { method, url, mode: effectiveMode },
      }).catch(
        /* v8 ignore next -- fail-safe: an audit-write failure never blocks the suppression itself */
        () => undefined,
      );
      return syntheticWriteResponse(url);
    });
  }
  return octokit;
}
