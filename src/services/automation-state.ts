// Shared derived-automation-state view (#6742). Extracted from the MCP server's `getAutomationState` so the
// REST route (GET /v1/repos/:owner/:repo/automation-state), the MCP tool (loopover_get_automation_state), and
// the CLI (`maintain automation-state`) all compute it ONE way -- the derived `mode` / `permissionReadiness` /
// `pendingActionCount` view that `GET /settings` deliberately does not return (settings returns only the
// resolved row). Keeping this in one function is what stops the three surfaces from drifting.
import { countPendingAgentActions, getInstallation, getRepository, isGlobalAgentFrozen } from "../db/repositories";
import { forcedSelfhostMode } from "../github/client";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "../settings/agent-execution";
import { AGENT_ACTION_CLASSES, isActingAutonomyLevel, resolveAutonomy } from "../settings/autonomy";

/** The derived automation-state view. Every field is the same one `getAutomationState` returned inline. */
export interface AutomationState {
  repoFullName: string;
  configured: boolean;
  autonomy: Awaited<ReturnType<typeof resolveRepositorySettings>>["autonomy"];
  autoMaintain: Awaited<ReturnType<typeof resolveRepositorySettings>>["autoMaintain"];
  agentPaused: boolean;
  agentDryRun: boolean;
  mode: ReturnType<typeof resolveAgentActionMode>;
  permissionReadiness: ReturnType<typeof resolveAgentPermissionReadiness>;
  actingActionClasses: (typeof AGENT_ACTION_CLASSES)[number][];
  pendingActionCount: number;
}

/**
 * Compute the derived automation-state view for a repo. Read-only: reads the repository row, the
 * yaml-merged effective settings (resolveRepositorySettings, not the raw DB row), the pending-approval count,
 * and the installation's granted permissions, then folds them into the same `mode` / acting-class /
 * permission-readiness derivation the MCP tool used inline. Performs no write and no authorization itself —
 * every caller gates access before calling (the route via requireRepoMaintainer, the MCP tool via its own
 * requireRepoAccess), exactly as before this was extracted.
 */
export async function buildAutomationState(env: Env, repoFullName: string): Promise<AutomationState> {
  const [repo, settings, pendingActionCount] = await Promise.all([
    getRepository(env, repoFullName),
    resolveRepositorySettings(env, repoFullName),
    countPendingAgentActions(env, { repoFullName, status: "pending" }),
  ]);
  const autonomy = settings.autonomy;
  const actingActionClasses = AGENT_ACTION_CLASSES.filter((actionClass) => isActingAutonomyLevel(resolveAutonomy(autonomy, actionClass)));
  const installation = repo?.installationId ? await getInstallation(env, repo.installationId) : null;
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
    instanceMode: forcedSelfhostMode(env),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const permissionReadiness = resolveAgentPermissionReadiness({ autonomy, installationPermissions: installation?.permissions ?? null });
  return {
    repoFullName,
    configured: actingActionClasses.length > 0,
    autonomy,
    autoMaintain: settings.autoMaintain,
    agentPaused: settings.agentPaused === true,
    agentDryRun: settings.agentDryRun === true,
    mode,
    permissionReadiness,
    actingActionClasses,
    pendingActionCount,
  };
}

/** The one-line human summary the MCP tool emits, kept here so its wording stays paired with the fields. */
export function automationStateSummary(state: AutomationState): string {
  return `Agent automation for ${state.repoFullName}: mode=${state.mode}, ${state.actingActionClasses.length} acting class(es), ${state.pendingActionCount} pending approval(s).`;
}
