// #9433: config-dependent fixes that ship INERT.
//
// Several production-behaviour fixes are gated on env vars that were never set, so the shipped code path
// stayed inert and the deployment silently behaved exactly like the pre-fix build. No unit test can catch this
// class: tests verify the mechanism works WHEN ENABLED, never that an operator set the variable. The confirmed
// instance (#9433) — `LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS` unset, so every AI review narrative
// containing the ordinary word "score" had its whole summary silently replaced by a placeholder — sat live for
// weeks with a green test suite.
//
// WHY THIS IS A REPORT, NOT MORE BOOT WARNINGS. The obvious fix — one `console.error` per var, mirroring
// `shouldWarnRagEmbedUnavailable` — does not generalize, and following it blindly makes things worse. Verified
// while writing this: `LOOPOVER_PUBLIC_STATS_REPOS` is unset on the self-host box and that is CORRECT, because
// the public-stats surface is served by the Cloudflare Worker (where wrangler.jsonc sets it to four repos).
// A boot warning there would fire on every self-host deployment forever, for a non-problem — the same alert
// fatigue that let a genuinely broken backup alert be ignored for 8 days. A warning is only justified when
// "unset" is wrong for EVERY deployment; that is rare, and each such case still earns its own dedicated
// warning at its own call site (the two that exist today are correct and stay).
//
// What is missing is not more noise but ANSWERABILITY: an operator has no way to ask "which config-gated
// behaviours are currently inert on this box?" without reading boot logs they have long since scrolled past.
// This module answers exactly that question, on demand, with zero steady-state noise.
//
// SCOPE, deliberately narrow. This reports only vars whose unset state changes OUTPUT CORRECTNESS — review
// content, gate disposition, or a published number. It does NOT report the ~100 `Default OFF` convergence
// flags in env.d.ts: those are opt-in features whose absence keeps the review path byte-identical, so listing
// them would bury the few entries that matter under a wall of working-as-intended noise.

/** One config-gated behaviour that is currently inert. */
export type InertConfigEntry = {
  /** The env var an operator would set. */
  key: string;
  /** What stops working while it is unset — phrased as the OBSERVABLE effect, not the mechanism. */
  impact: string;
  /**
   * Whether an unset value is wrong for every deployment, or legitimately correct for some.
   *
   * `always-wrong` earns a boot warning too (and today's two both have one). `deployment-specific` must NOT
   * be warned about — it is exactly the `LOOPOVER_PUBLIC_STATS_REPOS` case above, where the same unset value
   * is correct on one runtime and a defect on another, and only the operator knows which they are running.
   */
  severity: "always-wrong" | "deployment-specific";
};

/** Reads only the vars it names, so it is safe to call with `process.env` directly. */
export type InertConfigEnv = Record<string, string | undefined>;

function unset(value: string | undefined): boolean {
  return (value ?? "").trim() === "";
}

/**
 * Every config-gated behaviour currently inert in `env`, in a stable order.
 *
 * PURE — no IO, no clock, no logging — so the `/metrics` gauge, a `/ready` field, and a test can all read the
 * identical answer rather than three hand-maintained lists drifting apart (which is the same drift class this
 * whole issue is about).
 */
export function inertConfigEntries(env: InertConfigEnv): InertConfigEntry[] {
  const entries: InertConfigEntry[] = [];

  // The confirmed #9433 instance. Fail-closed by design, and the fail-closed direction is content-destroying:
  // sanitizePublicComment THROWS on a bare "score" match and the caller degrades to a generic placeholder, so
  // an unset allowlist silently strips narrative sentences on every repo. Correct for a deployment whose repos
  // genuinely carry private trust/reward data, hence deployment-specific rather than always-wrong.
  if (unset(env.LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS)) {
    entries.push({
      key: "LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS",
      impact:
        "AI review narratives lose any sentence using ordinary scoring vocabulary (\"score\", \"ranking\", \"reward\", \"reviewability\"), silently — the published summary looks fine, just shorter.",
      severity: "deployment-specific",
    });
  }

  // Verified unset on the ORB self-host box and CORRECT there: the public-stats surface runs on the Cloudflare
  // Worker, whose wrangler.jsonc sets it. Reported (never warned) precisely so an operator on a runtime that
  // DOES serve /v1/public/stats can see that the own-ledger half is publishing zeros.
  if (unset(env.LOOPOVER_PUBLIC_STATS_REPOS)) {
    entries.push({
      key: "LOOPOVER_PUBLIC_STATS_REPOS",
      impact:
        "The own-ledger half of /v1/public/stats reports zero (disposition counts, reversal-grounded accuracy, weekly totals). Harmless on a runtime that does not serve public stats; silently wrong on one that does.",
      severity: "deployment-specific",
    });
  }

  // Redaction is flag-gated while DETECTION is not (verified: reviewInputHasPromptInjection and its hold run
  // unconditionally), so an unset flag never lets a manipulated verdict through — it only means the reviewer
  // sees the raw injected text rather than a defanged copy. Reported because the inconclusive-finding copy
  // tells a reader the content "was redacted before review", which is untrue while this is off.
  if (unset(env.LOOPOVER_REVIEW_SAFETY)) {
    entries.push({
      key: "LOOPOVER_REVIEW_SAFETY",
      impact:
        "Prompt-injection text is still DETECTED and still holds the PR, but is not defanged before the model sees it — and the public finding claims it was redacted.",
      severity: "deployment-specific",
    });
  }

  return entries;
}

/** Stable, bounded label values for the `/metrics` gauge — the key set is fixed in code, so cardinality is
 *  bounded by construction and an operator can alert on a specific key without a cardinality risk. */
export function inertConfigGaugeSamples(env: InertConfigEnv): Array<{ labels: Record<string, string>; value: number }> {
  return inertConfigEntries(env).map((entry) => ({
    labels: { key: entry.key, severity: entry.severity },
    value: 1,
  }));
}
