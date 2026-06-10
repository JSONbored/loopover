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
