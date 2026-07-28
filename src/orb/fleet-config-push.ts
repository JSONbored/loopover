// Fleet config push, extracted from POST /v1/app/fleet/config-push (#9522).
//
// Moved out of the route handler so the MCP `loopover_fleet_config_push` tool runs the SAME fan-out, with
// the same per-target isolation and the same audit events, rather than a second copy that would drift.
// Nothing about the behavior changes here; only its address does.
import { enqueueConfigPushRelay, pruneRelayPending } from "./relay";
import { recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";

export type ConfigPushRequest = {
  installationIds: number[];
  pushId: string;
  message: string;
  capability?: string | undefined;
  deprecatesAt?: string | undefined;
};

export type ConfigPushResult = {
  ok: true;
  pushId: string;
  installationCount: number;
  succeededCount: number;
  failedInstallationIds: number[];
};

/**
 * Fan a config push out to the named installations.
 *
 * #7611: prunes ONCE for the whole request rather than once per target -- enqueueConfigPushRelay
 * deliberately no longer prunes itself, so a 500-installation fan-out cannot turn into 500 redundant
 * global TTL-prune scans against the shared orb_relay_pending table.
 *
 * #8880: each target's enqueue is isolated. A bare Promise.all let one target's throw abort the whole
 * fan-out, silently dropping the audit event and the response for the other ~499 installations. Each
 * failure is caught inside its own task and audited, so one bad row cannot sink the batch and no failure
 * is swallowed -- the caller still gets the successful targets plus the partial failure.
 */
export async function pushFleetConfig(env: Env, actor: string, request: ConfigPushRequest): Promise<ConfigPushResult> {
  const { installationIds, ...payload } = request;
  await pruneRelayPending(env);
  const settled = await Promise.all(
    installationIds.map(async (installationId): Promise<{ installationId: number; error?: string }> => {
      try {
        await enqueueConfigPushRelay(env, installationId, payload);
        return { installationId };
      } catch (error) {
        return { installationId, error: errorMessage(error) };
      }
    }),
  );
  const failedInstallationIds: number[] = [];
  for (const result of settled) {
    if (result.error !== undefined) {
      failedInstallationIds.push(result.installationId);
      await recordAuditEvent(env, {
        eventType: "operator.config_push_target_failed",
        actor,
        targetKey: `config_push#${request.pushId}#${result.installationId}`,
        outcome: "error",
        metadata: { installationId: result.installationId, pushId: request.pushId, message: result.error },
      });
    }
  }
  const succeededCount = installationIds.length - failedInstallationIds.length;
  await recordAuditEvent(env, {
    eventType: "operator.config_push_enqueued",
    actor,
    targetKey: `config_push#${request.pushId}`,
    outcome: failedInstallationIds.length > 0 ? "error" : "completed",
    metadata: { installationCount: installationIds.length, succeededCount, failedCount: failedInstallationIds.length, capability: payload.capability ?? null },
  });
  return { ok: true, pushId: request.pushId, installationCount: installationIds.length, succeededCount, failedInstallationIds };
}
