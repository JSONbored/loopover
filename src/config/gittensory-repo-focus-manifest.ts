/**
 * Bundled fallback for JSONbored/gittensory when the repo file is not yet reachable
 * (local dev, pre-merge branches). Keep aligned with `.gittensory.yml` at repo root.
 */
export const GITTENSORY_REPO_FOCUS_MANIFEST_YAML = `# Gittensory repo focus manifest — machine-readable contributor policy for this project.
# Private maintainerNotes stay in authenticated API surfaces only.

source: repo_file

wantedPaths:
  - src/
  - packages/
  - test/
  - migrations/
  - scripts/
  - review-enrichment/
  - .github/workflows/
  - wrangler.jsonc
  - apps/gittensory-ui/

preferredLabels:
  - bug
  - enhancement
  - documentation

linkedIssuePolicy: preferred

testExpectations:
  - npm run test:ci
  - npm run typecheck
  - npm run test:coverage

issueDiscoveryPolicy: discouraged

# Authoritative gate config, config-as-code (layered OVER dashboard repository settings:
# .gittensory.yml > DB settings > safe defaults). ONLY confirmed Gittensor contributors are ever
# hard-blocked (see PR #644); these fields only choose what the gate does, not who it applies to.
gate:
  # enabled: false             # set false to disable the gate from config (turning it on is a dashboard setting)
  linkedIssue: advisory        # block | advisory | off — issues aren't always available; advise, don't block
  duplicates: block            # block | advisory | off — block obvious duplicate PRs
  readiness:
    mode: advisory             # advisory | off — readiness score is informational and never blocks the Gate
    minScore: 40               # lowered from 60: 73% false-positive rate showed PRs scoring 40-59 merge freely
  # aiReview:                  # opt-in AI maintainer review (off by default; needs the AI flags enabled)
  #   mode: advisory           # block | advisory | off — block only blocks on a dual-model consensus defect
  #   byok: false              # use a maintainer Anthropic/OpenAI key for the write-up; consensus stays on the free/default reviewer
  #   allAuthors: false        # true reviews every PR author with the selected self-host model(s)
  #   provider: anthropic      # anthropic | openai — which BYOK provider (the secret key is set via the dashboard, never here)
  #   model: claude-3-5-sonnet-latest   # optional model override for the BYOK write-up

# Public review-panel content overrides (config-as-code). Maintainer text is dropped if it fails the
# public-safe filter; the Gittensor attribution + register link always stay appended to the footer.
# review:
#   footer:
#     text: "Reviewed by the Acme maintainer bot."     # custom lead line (attribution still appended)
#   note: "Run the test suite before requesting review."   # short intro line shown above the panel
#   fields:                                             # show/hide rows (default: all shown). Stable keys:
#     relatedWork: false                                # linkedIssue | relatedWork | reviewLoad (Change scope) |
#     openPrQueue: false                                # validationEvidence (Validation posture) | openPrQueue (Contributor workload) | contributorContext | gateResult

# AI-review eligibility filters (#3999): a draft PR previously re-triggered a full AI review on every
# push, letting a contributor iterate for free while tokens kept burning — skip_drafts stops that.
# skip_docs_only skips the reviewer entirely when every changed file is documentation, which never
# needs an AI pass.
review:
  auto_review:
    skip_drafts: true
    skip_docs_only: true

# Linked-issue label propagation (#priority-linked-issue-gate, #priority-linked-issue-gate-ownership,
# #priority-reward-maintainer-trust): a PR that closes/fixes/resolves an issue inherits that issue's
# point-bearing gittensor:* label onto the PR itself, instead of the PR's own label being decided purely by
# its commit-title prefix. bug/feature are \`trustMaintainerAuthoredIssue: true\` (routine categorization, no
# reward at stake, and the title-based fallback already has zero equivalent verification) so they propagate
# even when the PR author isn't a formal GitHub assignee of the issue — our issues are almost always
# maintainer-authored for open pickup and rarely formally assigned. priority is a scarce, maintainer-hand-
# picked reward label, so this public repo config keeps the strict author-or-assignee-only bar: a PR author
# controls closing-keyword text and must not be able to farm the reward label by citing an unrelated open
# maintainer issue. priority is also \`removeOtherTypeLabels: false\` (additive) -- unlike
# bug/feature, which are mutually-exclusive TYPE categories, priority is a separate reward dimension that
# coexists WITH whichever type already applies (an issue is routinely both gittensor:feature AND
# gittensor:priority at once); resolvePrTypeLabel composes every additive match alongside the one exclusive
# winner, rather than the two categories competing for a single slot.
#
# Review-evasion protection: closing or converting-to-draft your OWN PR while gittensory has an active
# review pass running, a prior recorded gate failure, or a repeated ready<->draft cycle on this PR, is
# treated as dodging the one-shot review rather than an ordinary action (layered OVER the dashboard's
# own default of "off").
settings:
  linkedIssueLabelPropagation:
    enabled: true
    mode: exclusive_type_label
    mappings:
      - issueLabel: "gittensor:bug"
        prLabel: "gittensor:bug"
        removeOtherTypeLabels: true
        trustMaintainerAuthoredIssue: true
      - issueLabel: "gittensor:feature"
        prLabel: "gittensor:feature"
        removeOtherTypeLabels: true
        trustMaintainerAuthoredIssue: true
      - issueLabel: "gittensor:priority"
        prLabel: "gittensor:priority"
        removeOtherTypeLabels: false
  reviewEvasionProtection: close

# Repo-doc generation roadmap (#2993/#3002) — opt-in only, off by default. Uncomment to let Gittensory open a
# PR generating AGENTS.md/CLAUDE.md from this repo's own profile.
# repoDocGeneration:
#   enabled: true                   # default false — must be explicitly turned on per repo
#   scope: [agents]                 # agents | skills — which generated file types are in play
#   allowOverwriteExisting: false   # required before Gittensory will touch an existing hand-maintained file

publicNotes:
  - Prefer backend Workers, MCP, GitHub App, registry, and scoring work when scope allows.
  - Focused control-panel UI changes are welcome when they use live API data or honest empty/error states and tie to safety, release readiness, or operator-facing analytics.
  - Do not reintroduce GitHub Pages, VitePress, site/, CNAME, or lovable-only website work.

maintainerNotes:
  - Maintainer notes are private triage context and must not appear on public GitHub comments.
  - Cosmetic UI-only polish without API wiring or maintainer-approved issue context should be redirected to backend or operator-facing work.
`;

export const GITTENSOR_SELF_REPO_DEFAULT = "JSONbored/gittensory";

export function resolveGittensorySelfRepoFullName(env: { GITTENSORY_DRIFT_ISSUE_REPO?: string }): string {
  const configured = env.GITTENSORY_DRIFT_ISSUE_REPO?.trim();
  if (configured && configured.includes("/")) return configured;
  return GITTENSOR_SELF_REPO_DEFAULT;
}
