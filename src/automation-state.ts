import { countPendingAgentActions, getInstallation, getRepository, isGlobalAgentFrozen } from "./db/repositories";
import { isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "./settings/agent-execution";
import { AGENT_ACTION_CLASSES, isActingAutonomyLevel, resolveAutonomy } from "./settings/autonomy";
import { resolveRepositorySettings } from "./settings/repository-settings";
import type { AgentActionClass, AutoMaintainPolicy, AutonomyPolicy } from "./types";

export type AutomationStateResponse = {
  repoFullName: string;
  configured: boolean;
  autonomy: AutonomyPolicy | undefined;
  autoMaintain: AutoMaintainPolicy | undefined;
  agentPaused: boolean;
  agentDryRun: boolean;
  mode: string;
  permissionReadiness: string;
  actingActionClasses: AgentActionClass[];
  pendingActionCount: number;
};

/**
 * A repo's agent automation state: per-action autonomy levels, kill-switch / dry-run mode, GitHub
 * write-permission readiness, and how many auto_with_approval actions are awaiting a maintainer decision.
 * Shared by loopover_get_automation_state (src/mcp/server.ts) and its REST mirror (src/api/routes.ts) so
 * the two surfaces can never drift (#6742).
 */
export async function buildAutomationStateResponse(env: Env, repoFullName: string): Promise<AutomationStateResponse> {
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
