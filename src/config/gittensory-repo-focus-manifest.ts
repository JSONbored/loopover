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
  - .github/workflows/
  - wrangler.jsonc
  - apps/gittensory-ui/

blockedPaths:
  - site/
  - CNAME
  - "**/lovable/**"

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
    mode: advisory             # block | advisory | off — readiness-score floor
    minScore: 60
  # aiReview:                  # opt-in AI maintainer review (off by default; needs the AI flags enabled)
  #   mode: advisory           # block | advisory | off — block only blocks on a dual-model consensus defect
  #   byok: false              # use a maintainer Anthropic/OpenAI key for the write-up; consensus stays free Workers AI
  #   provider: anthropic      # anthropic | openai — which BYOK provider (the secret key is set via the dashboard, never here)
  #   model: claude-3-5-sonnet-latest   # optional model override for the BYOK write-up

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
