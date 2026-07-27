// LoopOver Orb central GitHub App (#1255) — installation registry maintenance.
//
// Keeps orb_github_installations in sync with the App's `installation` lifecycle events (created /
// new_permissions_accepted / suspend / unsuspend / deleted). A fast, idempotent upsert run synchronously
// from the verified webhook receiver — onboarding + the token-broker (later PRs) read this registry.
// registered stays 0 (the manual-onboarding gate) and is NEVER touched here — an install is recorded but not
// trusted until an operator opts it in.
import { listOrbAppInstallations } from "./app-auth";
import type { GitHubWebhookPayload } from "../types";

export async function upsertOrbInstallation(env: Env, eventName: string, payload: GitHubWebhookPayload): Promise<void> {
  if (eventName !== "installation") return; // installation_repositories repo-delta tracking is a follow-up
  const inst = payload.installation;
  if (!inst?.id) return;

  switch (payload.action) {
    case "created":
    case "new_permissions_accepted":
      await env.DB.prepare(
        `INSERT INTO orb_github_installations (installation_id, account_login, account_type, account_id, repository_selection, last_event_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(installation_id) DO UPDATE SET
           account_login = excluded.account_login, account_type = excluded.account_type, account_id = excluded.account_id,
           repository_selection = excluded.repository_selection,
           suspended_at = NULL, removed_at = NULL, last_event_at = CURRENT_TIMESTAMP`,
      )
        .bind(inst.id, inst.account?.login ?? null, inst.account?.type ?? null, inst.account?.id ?? null, inst.repository_selection ?? null)
        .run();
      return;
    case "deleted":
      await env.DB.prepare(`UPDATE orb_github_installations SET removed_at = CURRENT_TIMESTAMP, last_event_at = CURRENT_TIMESTAMP WHERE installation_id = ?`).bind(inst.id).run();
      return;
    case "suspend":
      await env.DB.prepare(`UPDATE orb_github_installations SET suspended_at = CURRENT_TIMESTAMP, last_event_at = CURRENT_TIMESTAMP WHERE installation_id = ?`).bind(inst.id).run();
      return;
    case "unsuspend":
      await env.DB.prepare(`UPDATE orb_github_installations SET suspended_at = NULL, last_event_at = CURRENT_TIMESTAMP WHERE installation_id = ?`).bind(inst.id).run();
      return;
    default:
      return; // other installation actions carry no registry change
  }
}

/**
 * Reconciles the registry against GitHub's authoritative installation list — recovers installs whose
 * `installation` webhook fired before the receiver's secret was configured (so they were never recorded). Upserts
 * each install WITHOUT touching `registered`, so a re-run never re-trusts an opted-out install; new rows land at
 * the default registered=0 (the manual-onboarding gate).
 *
 * #9151: `suspended_at` is written through from GitHub's own `listOrbAppInstallations` response instead of being
 * hardcoded to NULL — a suspension recorded by the `installation.suspend` webhook (above) is the ONLY registry-side
 * signal that an account owner revoked consent (see brokerOrbToken's eligibility check, broker.ts, and the
 * "Installation not active" check, oauth.ts), and no `unsuspend` webhook is guaranteed to ever arrive to restore it
 * if a backfill silently erased it. `removed_at` stays cleared to NULL: unlike suspension, GitHub's
 * `GET /app/installations` (what `listOrbAppInstallations` walks) never lists an actually-uninstalled App at
 * all — every install this loop sees is, by definition, currently installed, so clearing `removed_at` here
 * reflects reality rather than resurrecting a removed install the backfill never actually saw.
 */
export async function backfillOrbInstallations(env: Env): Promise<{ backfilled: number }> {
  const installs = await listOrbAppInstallations(env);
  for (const inst of installs) {
    await env.DB.prepare(
      `INSERT INTO orb_github_installations (installation_id, account_login, account_type, account_id, repository_selection, suspended_at, last_event_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(installation_id) DO UPDATE SET
         account_login = excluded.account_login, account_type = excluded.account_type, account_id = excluded.account_id,
         repository_selection = excluded.repository_selection, suspended_at = excluded.suspended_at, removed_at = NULL,
         last_event_at = CURRENT_TIMESTAMP`,
    )
      .bind(inst.id, inst.accountLogin, inst.accountType, inst.accountId, inst.repositorySelection, inst.suspendedAt)
      .run();
  }
  return { backfilled: installs.length };
}
