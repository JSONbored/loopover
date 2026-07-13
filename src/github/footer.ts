// Shared footer for public LoopOver PR comments — and the viral-growth loop that drives outside
// contributors to register on Gittensor. The audience-aware variant leads with an "earn" CTA for
// contributors who are NOT yet registered (the conversion target); confirmed contributors get a
// lighter line. The link persists on the PR forever, so every reviewed PR keeps inviting.
//
// PRIVACY: public comments must never use reward/payout/score/ranking wording (those throw in
// `sanitizePublicComment` via FORBIDDEN_PUBLIC_COMMENT_WORDS, and the product keeps private
// scoreability out of public output). This footer uses ONLY "earn" — a factual, public invitation,
// not a payout guarantee or a private-score disclosure.

/** The LoopOver product site (marketing on-ramp / attribution target) -- the DEFAULT only. A
 *  self-hoster with `PUBLIC_SITE_ORIGIN` set gets their own domain instead, both here and in
 *  `gittensoryFooter` below (#4613). */
export const GITTENSORY_SITE_URL = "https://loopover.ai";

/** Minimal env slice `gittensoryFooter` needs, narrowed from the full `Env` the same way this file's
 *  `maintainerControlPanelUrl` already narrows its own `env` param inline -- so every file that renders
 *  the footer only has to thread this one field down from wherever the real `Env` is in scope, not the
 *  whole worker binding type. */
export type GittensoryFooterEnv = { PUBLIC_SITE_ORIGIN?: string | undefined };

/** The maintainer control panel for a repo on the LoopOver site (`/app?view=maintainer&repo=…`). Used as the
 *  check-run `details_url` so the merge-box "Details" link lands on the repo's review panel instead of GitHub's
 *  generic check page, and as the in-comment control-panel link. Returns null only if URL construction throws. */
export function maintainerControlPanelUrl(env: { PUBLIC_SITE_ORIGIN?: string | undefined }, repoFullName: string): string | null {
  const origin = env.PUBLIC_SITE_ORIGIN ?? GITTENSORY_SITE_URL;
  try {
    const url = new URL("/app", origin);
    url.searchParams.set("view", "maintainer");
    url.searchParams.set("repo", repoFullName);
    return url.toString();
  } catch {
    return null;
  }
}
/** The public command-reference doc link for `@gittensory help` (#4670) and the "[BETA] Chat with
 *  Gittensory" public-safe collapsible (#5078). Lives here (not commands.ts/engine.ts) so both can import
 *  the SAME resolved URL without a circular module edge -- commands.ts already imports from signals/engine.ts,
 *  so engine.ts importing back from commands.ts would cycle. `new URL(path, origin)` -- same idiom as the
 *  sibling `maintainerControlPanelUrl` above -- so a `PUBLIC_SITE_ORIGIN` with or without a trailing slash
 *  both resolve correctly instead of risking a double slash from naive concatenation. Falls back to the
 *  literal path string only if origin resolution itself throws (an operator-misconfigured PUBLIC_SITE_ORIGIN
 *  should degrade the link, not crash comment rendering). */
export function commandReferenceUrl(env: GittensoryFooterEnv): string {
  const origin = env.PUBLIC_SITE_ORIGIN ?? GITTENSORY_SITE_URL;
  try {
    return new URL("/docs/gittensory-commands", origin).toString();
  } catch {
    return `${GITTENSORY_SITE_URL}/docs/gittensory-commands`;
  }
}

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
 *  Uses only "earn" wording — never reward/payout/score (forbidden in public comments).
 *  `env.PUBLIC_SITE_ORIGIN` (same resolution as `maintainerControlPanelUrl` above) lets a self-hoster's
 *  own domain replace `GITTENSORY_SITE_URL` in the "Checked by LoopOver" attribution link (#4613) --
 *  the Gittensor register link (`GITTENSOR_HOME_URL`) is a separate, shared network and is never rebranded. */
export function gittensoryFooter(env: GittensoryFooterEnv, opts: { earnUrl?: string | undefined; customText?: string | undefined } = {}): string {
  const siteUrl = env.PUBLIC_SITE_ORIGIN ?? GITTENSORY_SITE_URL;
  const earnUrl = opts.earnUrl ?? GITTENSOR_HOME_URL;
  // Maintainer-customized footer (via `.gittensory.yml review.footer.text`): the maintainer's public-safe
  // lead replaces the default CTA copy, but the Gittensor register link + LoopOver attribution are
  // ALWAYS appended — the growth surface is preserved regardless of customization.
  if (opts.customText) {
    return [
      opts.customText,
      "",
      `[Gittensor](${GITTENSOR_HOME_URL}) lets GitHub contributors earn for the work they already do — [register to start earning →](${earnUrl}). Checked by [LoopOver](${siteUrl}).`,
    ].join("\n");
  }
  return [
    `💰 **Earn for open-source contributions like this.** [Gittensor](${GITTENSOR_HOME_URL}) lets GitHub contributors earn for the work they already do — [register to start earning →](${earnUrl}).`,
    "",
    `Checked by [LoopOver](${siteUrl}), a quiet PR intelligence layer for OSS maintainers.`,
  ].join("\n");
}
