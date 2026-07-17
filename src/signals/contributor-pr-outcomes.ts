// Contributor post-merge outcome history (#6747) — the shared builder behind the loopover_pr_outcome MCP tool,
// its GET /v1/contributors/:login/pr-outcomes REST mirror, and the CLI, so all three surfaces return one
// byte-identical payload for one login. Reads the same `pull_request_merged` notification deliveries the tool
// reads (via listNotificationDeliveriesForRecipient) and shapes each into a public-safe outcome record: the
// attribution text is the delivery body, never any wallet/hotkey/scoring internals.
import { listNotificationDeliveriesForRecipient } from "../db/repositories";

const DEFAULT_OUTCOME_LIMIT = 50;

export type ContributorPrOutcome = {
  repoFullName: string;
  pullNumber: number | null;
  outcome: "merged";
  attribution: string;
  deeplink: string;
  recordedAt: string;
};

export type ContributorPrOutcomes = {
  login: string;
  count: number;
  outcomes: ContributorPrOutcome[];
};

/** Build a contributor's own merged-PR outcome history (#6747). Self-scoping is the caller's responsibility
 *  (requireContributorAccess on the route, requireContributorAccess() in the tool); this only reads + shapes. */
export async function buildContributorPrOutcomes(env: Env, login: string, limit?: number): Promise<ContributorPrOutcomes> {
  const deliveries = await listNotificationDeliveriesForRecipient(env, login, {
    eventType: "pull_request_merged",
    limit: limit ?? DEFAULT_OUTCOME_LIMIT,
  });
  const outcomes: ContributorPrOutcome[] = deliveries.map((delivery) => ({
    repoFullName: delivery.repoFullName,
    pullNumber: delivery.pullNumber,
    outcome: "merged",
    attribution: delivery.body,
    deeplink: delivery.deeplink,
    recordedAt: delivery.createdAt,
  }));
  return { login: login.toLowerCase(), count: outcomes.length, outcomes };
}
