// Shared footer for public Gittensory PR comments — and the viral-growth loop that drives outside
// contributors to register on Gittensor. The audience-aware variant leads with an "earn" CTA for
// contributors who are NOT yet registered (the conversion target); confirmed contributors get a
// lighter line. The link persists on the PR forever, so every reviewed PR keeps inviting.
//
// PRIVACY: public comments must never use reward/payout/score/ranking wording (those throw in
// `sanitizePublicComment` via FORBIDDEN_PUBLIC_COMMENT_WORDS, and the product keeps private
// scoreability out of public output). This footer uses ONLY "earn" — a factual, public invitation,
// not a payout guarantee or a private-score disclosure.

/** The Gittensory product site (marketing on-ramp / attribution target). */
export const GITTENSORY_SITE_URL = "https://gittensory.aethereal.dev";
/** The Gittensor network — where GitHub contributors register to earn for their contributions. */
export const GITTENSOR_HOME_URL = "https://gittensor.io";

/** Public "who's earning on this repo" page — social proof + a registration path, scoped to one
 *  repo. Used for repos already registered on Gittensor (a contributor who just opened a PR here
 *  sees that contributions to THIS repo earn, then a path to join). */
export function gittensorRepoEarnUrl(repoFullName: string): string {
  return `${GITTENSOR_HOME_URL}/miners/repository?name=${encodeURIComponent(repoFullName)}&tab=miners`;
}

/** Always-on public-comment footer + earn CTA. This is a permanent, free marketing surface: it
 *  appears on EVERY reviewed PR (the link persists forever), so non-registered authors see the
 *  invite and anyone viewing a registered contributor's PR sees it too. The registered/non-registered
 *  distinction lives in the review BODY (full panel vs. minimal), not here.
 *  Uses only "earn" wording — never reward/payout/score (forbidden in public comments). */
export function gittensoryFooter(opts: { earnUrl?: string | undefined } = {}): string {
  const earnUrl = opts.earnUrl ?? GITTENSOR_HOME_URL;
  return [
    `💰 **Earn for open-source contributions like this.** [Gittensor](${GITTENSOR_HOME_URL}) lets GitHub contributors earn for the work they already do — [register to start earning →](${earnUrl}).`,
    "",
    `Checked by [Gittensory](${GITTENSORY_SITE_URL}), a quiet PR intelligence layer for OSS maintainers.`,
  ].join("\n");
}
