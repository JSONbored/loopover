import { isProtectedAutomationAuthor } from "./agent-actions";

export type AutomationBotSkipMode = "inherit" | "off" | "enabled";

/** Truthy convention matches the rest of this codebase (`/^(1|true|yes|on)$/i`, e.g. isReputationEnabled),
 *  inverted: this flag defaults ON (skip), so only an explicit falsy value ("0"/"false"/"no"/"off") turns it
 *  off install-wide. Unlike most `LOOPOVER_REVIEW_*` flags (opt-in, default off), eliminating AI/gate spend
 *  on PRs from known, maintainer-owned automation (release-please's github-actions[bot], Renovate,
 *  Dependabot) is safe and low-risk enough to be the sensible default -- it should not require every
 *  self-host operator to discover and separately opt into this. */
export function isSkipAutomationBotPullRequestsEnabledGlobally(env: { GITTENSORY_SKIP_AUTOMATION_BOT_PRS?: string | undefined }): boolean {
  return !/^(0|false|no|off)$/i.test((env.GITTENSORY_SKIP_AUTOMATION_BOT_PRS ?? "").trim());
}

/** Per-repo override resolved against the global default. Mirrors `ModerationGateMode`'s inherit/off/enabled
 *  shape (settings/moderation-rules.ts) but is symmetric -- "off" and "enabled" both fully override the
 *  global default in either direction, unlike moderation's global-is-authoritative asymmetry -- because this
 *  is a narrower, lower-stakes waste-reduction toggle (skip review for known automation), not a fleet-wide
 *  safety kill-switch, so there's no reason a repo opting IN should still be blocked by a globally-off
 *  default. */
export function resolveSkipAutomationBotPullRequests(globalDefault: boolean, mode: AutomationBotSkipMode | null | undefined): boolean {
  if (mode === "off") return false;
  if (mode === "enabled") return true;
  return globalDefault;
}

/**
 * SECURITY (do not weaken without re-reading this comment): decides whether the review pipeline may treat
 * the CURRENT webhook event as bot-originated automation and skip full review for it. This is a trust
 * boundary, not a convenience check -- getting it wrong lets a contributor slip a PR past review entirely.
 *
 * Checks the actor who triggered THIS SPECIFIC event (`sender`), never just the PR's original/stored author.
 * A `pull_request` webhook's `sender` is "whoever performed the action that fired this event" -- for
 * `opened`, that's whoever opened the PR; for `synchronize`, that's whoever pushed the new commits, which is
 * NOT necessarily the PR's original author. If this checked only the stored PR author, an actor with write
 * access to an EXISTING bot-authored PR's branch (a fork with "allow edits by maintainers" enabled, or a
 * misconfigured branch permission) could push malicious commits onto that branch and inherit the bot's
 * skip-review treatment for a `synchronize` event `sender` did not actually originate from the bot.
 *
 * Requires BOTH `sender` (this event's actor) AND the PR's own recorded author to be in the trusted set --
 * defense in depth: a legitimate bot-originated event always satisfies both (the bot both opened the PR and
 * is the one pushing to it), so requiring both closes any path where they could diverge without narrowing
 * the legitimate case.
 *
 * `sender.login`/`sender.type` are GitHub's own attestation of who/what performed the action, delivered in an
 * HMAC-signed webhook payload verified before this ever runs (see github/webhook.ts) -- neither is spoofable
 * by a contributor's own request. GitHub also does not permit a regular ("User"-type) account to register a
 * `[bot]`-suffixed login, and each bot's login (e.g. "renovate[bot]") is tied to a single, globally-unique
 * GitHub App slug no other party can claim -- so `isProtectedAutomationAuthor`'s exact-match allowlist
 * (settings/agent-actions.ts) cannot be satisfied by an untrusted contributor's own account, and the
 * `type === "Bot"` check is still required as defense in depth against a future looser login match.
 */
export function isTrustedAutomationBotWebhookActor(
  sender: { login?: string | null | undefined; type?: string | null | undefined } | null | undefined,
  prAuthorLogin: string | null | undefined,
): boolean {
  return (
    sender?.type === "Bot" &&
    isProtectedAutomationAuthor(sender.login) &&
    isProtectedAutomationAuthor(prAuthorLogin)
  );
}

/**
 * Re-entry paths have no live webhook `sender`, so stored authorship is only a necessary precondition for the
 * automation skip. Callers must first perform their own freshness/provenance check (for example, confirming the
 * live PR head still matches the stored head) before using this result to bypass review. Original PR authorship
 * alone does not prove that later commits on the branch were still produced by the trusted bot.
 */
export function isTrustedAutomationBotAuthor(prAuthorLogin: string | null | undefined): boolean {
  return isProtectedAutomationAuthor(prAuthorLogin);
}
