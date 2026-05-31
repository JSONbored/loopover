/**
 * Static mock fixtures used by /app/* surfaces while the live API is being wired.
 * Every shape is intentionally faithful to the public Gittensory API contract
 * so that swapping in real `fetch` calls later is a one-line change per query.
 */

export type Boundary = "public" | "private-mcp" | "private-api";

export interface MockSession {
  login: string;
  github_id: number;
  roles: Array<"miner" | "maintainer" | "owner" | "operator">;
  confirmed_miner: boolean;
}

export const mockSession: MockSession = {
  login: "demo-miner",
  github_id: 4242424,
  roles: ["miner", "maintainer"],
  confirmed_miner: true,
};

export interface NextAction {
  id: string;
  title: string;
  repo: string;
  lane: "pursue" | "cleanup-first" | "maintainer-lane" | "avoid";
  scoreability:
    | "ready"
    | "blocked-gated"
    | "after-pending"
    | "linked-issue-needed"
    | "best-reasonable";
  rationale: string;
  evidence: string[];
  boundary: Boundary;
}

export const mockNextActions: NextAction[] = [
  {
    id: "act_01",
    title: "Clear stale draft PR before opening new work",
    repo: "entrius/gittensor",
    lane: "cleanup-first",
    scoreability: "blocked-gated",
    rationale: "Open-PR pressure is at queue cap; clearing PR #482 unlocks scoreability.",
    evidence: ["pr #482 idle 11d", "queue capacity 1/1", "no linked issue"],
    boundary: "private-mcp",
  },
  {
    id: "act_02",
    title: "Link issue #1204 before opening the test-coverage PR",
    repo: "entrius/gittensor",
    lane: "pursue",
    scoreability: "linked-issue-needed",
    rationale:
      "Issue exists, branch already addresses it — adding the link makes the PR scoreable.",
    evidence: ["issue #1204 matches branch", "label policy requires fixes:"],
    boundary: "private-mcp",
  },
  {
    id: "act_03",
    title: "Avoid duplicate work on docs/typo cluster",
    repo: "entrius/gittensor",
    lane: "avoid",
    scoreability: "blocked-gated",
    rationale: "Three open PRs already cover this surface; expected duplicate-close.",
    evidence: ["3 overlapping PRs in last 7d", "maintainer-lane preference set"],
    boundary: "private-mcp",
  },
];

export interface BlockerGroup {
  group: "account" | "queue" | "branch" | "linked-issue" | "cleanup";
  items: Array<{ code: string; title: string; how_to_clear: string }>;
}

export const mockBlockers: BlockerGroup[] = [
  {
    group: "queue",
    items: [
      {
        code: "queue_capacity_reached",
        title: "Open PR queue at capacity",
        how_to_clear: "Close or merge one open PR; capacity is 1 for this account today.",
      },
    ],
  },
  {
    group: "linked-issue",
    items: [
      {
        code: "needs_linked_issue",
        title: "Branch addresses an issue but isn't linked",
        how_to_clear: "Add `Fixes #1204` to the PR body or commit message.",
      },
    ],
  },
  {
    group: "cleanup",
    items: [
      {
        code: "stale_draft",
        title: "Draft PR has been idle 11 days",
        how_to_clear: "Push an update or close the draft.",
      },
    ],
  },
];

export interface ProjectionScenario {
  name: string;
  label: string;
  weight: number; // 0..1 relative bar length
  note: string;
}

export const mockProjections: ProjectionScenario[] = [
  {
    name: "gated",
    label: "Gated scoreability today",
    weight: 0.18,
    note: "Active blockers in effect.",
  },
  {
    name: "after-pending",
    label: "After pending merges land",
    weight: 0.35,
    note: "Two upstream merges expected.",
  },
  { name: "clean", label: "Clean-gate scenario", weight: 0.6, note: "If all blockers cleared." },
  {
    name: "best-reasonable",
    label: "Best reasonable case",
    weight: 0.78,
    note: "Excludes guarantees; private context.",
  },
];

export interface RepoFit {
  repo: string;
  lane: "pursue" | "avoid" | "maintainer-lane";
  why: string;
}

export const mockRepoFit: RepoFit[] = [
  {
    repo: "entrius/gittensor",
    lane: "pursue",
    why: "Confirmed miner; intake healthy; linked-issue policy permissive.",
  },
  {
    repo: "entrius/gittensor-docs",
    lane: "maintainer-lane",
    why: "Maintainer-lane policy enabled; redirect docs work to maintainers.",
  },
  {
    repo: "third-party/example-fork",
    lane: "avoid",
    why: "Not in registry; out-of-scope for scoring.",
  },
];

export interface AgentRun {
  id: string;
  source: "mcp" | "api" | "github-command";
  kind: "plan-next-work" | "preflight-branch" | "prepare-pr-packet" | "explain-blockers";
  repo: string;
  ranked_actions: number;
  ruleset_snapshot: string;
  signal_fidelity: "ready" | "degraded" | "stale" | "blocked";
  boundary: Boundary;
  created_at: string;
  summary?: string;
  recommendations?: string[];
}

export const mockRuns: AgentRun[] = [
  {
    id: "run_91x4",
    source: "mcp",
    kind: "plan-next-work",
    repo: "entrius/gittensor",
    ranked_actions: 3,
    ruleset_snapshot: "rs_2026_05_29_a1f3",
    signal_fidelity: "ready",
    boundary: "private-mcp",
    created_at: "2026-05-30T11:42:00Z",
  },
  {
    id: "run_91x3",
    source: "api",
    kind: "prepare-pr-packet",
    repo: "entrius/gittensor",
    ranked_actions: 1,
    ruleset_snapshot: "rs_2026_05_29_a1f3",
    signal_fidelity: "ready",
    boundary: "public",
    created_at: "2026-05-30T10:12:00Z",
  },
  {
    id: "run_91x2",
    source: "github-command",
    kind: "explain-blockers",
    repo: "entrius/gittensor",
    ranked_actions: 2,
    ruleset_snapshot: "rs_2026_05_28_71d2",
    signal_fidelity: "degraded",
    boundary: "private-api",
    created_at: "2026-05-29T17:55:00Z",
  },
  {
    id: "run_91x1",
    source: "mcp",
    kind: "preflight-branch",
    repo: "entrius/gittensor-docs",
    ranked_actions: 0,
    ruleset_snapshot: "rs_2026_05_28_71d2",
    signal_fidelity: "stale",
    boundary: "private-mcp",
    created_at: "2026-05-29T14:01:00Z",
  },
];

export interface InstallationHealth {
  id: string;
  account: string;
  repos: number;
  status: "ready" | "degraded" | "blocked";
  permissions_ok: boolean;
  webhook_ok: boolean;
  last_event: string;
}

export const mockInstallations: InstallationHealth[] = [
  {
    id: "inst_001",
    account: "entrius",
    repos: 4,
    status: "ready",
    permissions_ok: true,
    webhook_ok: true,
    last_event: "2026-05-30T11:30:00Z",
  },
  {
    id: "inst_002",
    account: "demo-org",
    repos: 2,
    status: "degraded",
    permissions_ok: true,
    webhook_ok: false,
    last_event: "2026-05-29T08:11:00Z",
  },
];

export interface ReviewabilityRow {
  pr: string;
  title: string;
  author: string;
  bucket: "review-now" | "needs-author" | "watch" | "redirect";
  lane: string;
  reason: string;
}

export const mockReviewability: ReviewabilityRow[] = [
  {
    pr: "#1218",
    title: "Tighten queue cap copy",
    author: "demo-miner",
    bucket: "review-now",
    lane: "pursue",
    reason: "Small, linked, clean preflight.",
  },
  {
    pr: "#1215",
    title: "Refactor scorer adapter",
    author: "alice",
    bucket: "watch",
    lane: "pursue",
    reason: "Large diff; wait for green checks.",
  },
  {
    pr: "#1212",
    title: "Update README typos",
    author: "bob",
    bucket: "redirect",
    lane: "maintainer-lane",
    reason: "Maintainer-lane preferred for docs.",
  },
  {
    pr: "#1210",
    title: "Add scoring weights doc",
    author: "carol",
    bucket: "needs-author",
    lane: "pursue",
    reason: "Missing linked issue.",
  },
];

export interface NoiseMetric {
  label: string;
  value: number;
  spark: number[];
}

export const mockNoiseMetrics: NoiseMetric[] = [
  { label: "Quiet skips", value: 312, spark: [3, 6, 4, 8, 11, 9, 14, 12, 18, 22, 19, 24, 28, 31] },
  { label: "Comments suppressed", value: 87, spark: [1, 0, 2, 3, 2, 5, 4, 7, 6, 9, 8, 11, 9, 12] },
  { label: "Labels applied", value: 144, spark: [2, 4, 3, 6, 5, 8, 7, 9, 11, 10, 13, 12, 15, 14] },
  { label: "Confirmed-miner PRs", value: 21, spark: [0, 1, 0, 1, 2, 1, 2, 1, 3, 2, 3, 3, 4, 3] },
];

export interface RegistrationStep {
  id: string;
  title: string;
  status: "ok" | "warn" | "blocked";
  detail: string;
}

export const mockRegistrationReadiness: RegistrationStep[] = [
  {
    id: "labels",
    title: "Label policy",
    status: "ok",
    detail: "fixes:, type:, area: labels present.",
  },
  {
    id: "intake",
    title: "Intake mode",
    status: "warn",
    detail: "Direct-PR enabled; consider issue-discovery for better scoreability.",
  },
  {
    id: "maint_lane",
    title: "Maintainer-lane",
    status: "ok",
    detail: "Configured for docs/* paths.",
  },
  {
    id: "tests",
    title: "Test policy checks",
    status: "blocked",
    detail: "CI does not export validation summary.",
  },
  {
    id: "config",
    title: "Gittensor config",
    status: "warn",
    detail: "Recommendation available — see suggested diff.",
  },
];

export interface UsageMetric {
  label: string;
  value: string;
  delta?: string;
}

export const mockUsageMetrics: UsageMetric[] = [
  { label: "Active miners (7d)", value: "84", delta: "+12" },
  { label: "App installs", value: "37", delta: "+3" },
  { label: "MCP versions in use", value: "0.2.x", delta: "stable" },
  { label: "PRs preflighted", value: "612", delta: "+88" },
  { label: "Packets generated", value: "284", delta: "+41" },
  { label: "Quiet skips", value: "1,204", delta: "+193" },
];

export interface RoadmapItem {
  title: string;
  status: "shipping-soon" | "planned" | "exploring";
  description: string;
}

export const mockRoadmap: RoadmapItem[] = [
  {
    title: "@gittensory GitHub command agent",
    status: "shipping-soon",
    description: "Quiet, opt-in @-commands maintainers can use inside PR threads.",
  },
  {
    title: "Product usage analytics",
    status: "shipping-soon",
    description: "Weekly value report and operator dashboard.",
  },
  {
    title: "Browser extension PR overlays",
    status: "planned",
    description: "Private maintainer overlays on github.com — never shown to PR authors.",
  },
  {
    title: "PWA maintainer digest",
    status: "planned",
    description: "Mobile-friendly daily digest of reviewability + install health.",
  },
  {
    title: "Optional AI summaries",
    status: "exploring",
    description: "Strictly over deterministic signals; never replaces evidence.",
  },
];

// ─── @gittensory command simulator fixtures ──────────────────────────────────

export interface CommandSample {
  id: string;
  command: string;
  usage: string;
  description: string;
  audience: "anyone" | "maintainer" | "confirmed-miner";
  boundary: Boundary;
  reply: string;
}

export const mockCommands: CommandSample[] = [
  {
    id: "help",
    command: "@gittensory help",
    usage: "@gittensory help",
    description: "Lists available commands and who can run each.",
    audience: "anyone",
    boundary: "public",
    reply: `**Gittensory** · commands available on this repo

- \`@gittensory preflight\` — confirmed-miner branch preflight (maintainer-visible only)
- \`@gittensory blockers\` — maintainer-only blocker breakdown
- \`@gittensory duplicate-check\` — flags overlap with open PRs (private context)
- \`@gittensory miner-context\` — confirmed-miner provenance for this PR
- \`@gittensory next-action\` — one ranked next action for the author

_Replies are scoped to the requester. Private context never appears in public threads._`,
  },
  {
    id: "preflight",
    command: "@gittensory preflight",
    usage: "@gittensory preflight",
    description:
      "Runs the deterministic preflight on the current branch and returns a public-safe summary.",
    audience: "maintainer",
    boundary: "public",
    reply: `**Preflight · public summary**

- Linked issue: #1204 ✓
- Validation summary: present ✓
- Squash status: needs squash ⚠
- Diff size: small (3 files, +84 / −12)

_Full reasoning available to maintainers via \`@gittensory blockers\`._`,
  },
  {
    id: "blockers",
    command: "@gittensory blockers",
    usage: "@gittensory blockers",
    description: "Maintainer-only blocker list with how-to-clear notes. Never posted publicly.",
    audience: "maintainer",
    boundary: "private-api",
    reply: `**Blockers (maintainer-only)**

\`queue_capacity_reached\` — author at 1/1 open-PR cap. Clearing PR #482 unblocks.
\`needs_linked_issue\` — branch addresses #1204 but missing \`Fixes #1204\`.
\`unsquashed_commits\` — 4 commits on branch; squash on merge recommended.

_This reply is delivered via maintainer DM, not the public PR thread._`,
  },
  {
    id: "duplicate-check",
    command: "@gittensory duplicate-check",
    usage: "@gittensory duplicate-check",
    description: "Returns overlap with open PRs and recent merges; reasoning stays private.",
    audience: "maintainer",
    boundary: "private-api",
    reply: `**Duplicate check**

- PR #1180 — 62% file overlap (open, idle 6d)
- PR #1162 — 38% file overlap (merged 4d ago)
- Recommend redirect or close-with-credit before review.`,
  },
  {
    id: "miner-context",
    command: "@gittensory miner-context",
    usage: "@gittensory miner-context",
    description:
      "Confirms whether the PR author is a registered Gittensor miner and shows public provenance only.",
    audience: "maintainer",
    boundary: "public",
    reply: `**Miner context**

- Author: \`octocat\` — confirmed Gittensor miner ✓
- Active in: 3 registered repos
- Public provenance only. No scoring, reward, or risk numbers.`,
  },
  {
    id: "next-action",
    command: "@gittensory next-action",
    usage: "@gittensory next-action",
    description:
      "Posts the single highest-priority next action for the PR author, sanitized for the public thread.",
    audience: "confirmed-miner",
    boundary: "public",
    reply: `**Suggested next action**

Add \`Fixes #1204\` to the PR body so this branch becomes scoreable. No other public changes required.`,
  },
];

// ─── Product analytics fixtures ──────────────────────────────────────────────

export interface AnalyticsSeries {
  label: string;
  total: string;
  delta: string;
  values: number[]; // 8 weekly buckets
}

export const mockAnalytics: AnalyticsSeries[] = [
  { label: "MCP installs", total: "612", delta: "+9%", values: [42, 51, 48, 60, 72, 81, 88, 96] },
  {
    label: "Active miners (7d)",
    total: "84",
    delta: "+18%",
    values: [38, 41, 46, 52, 58, 67, 76, 84],
  },
  {
    label: "Branch analyses run",
    total: "2,184",
    delta: "+22%",
    values: [120, 140, 165, 190, 230, 280, 320, 380],
  },
  {
    label: "@gittensory commands used",
    total: "412",
    delta: "+34%",
    values: [12, 18, 24, 33, 48, 65, 88, 124],
  },
  {
    label: "PR noise reduced",
    total: "−47%",
    delta: "↓ noise",
    values: [10, 14, 19, 26, 32, 38, 44, 47],
  },
  {
    label: "Quiet skips",
    total: "1,204",
    delta: "+193",
    values: [60, 90, 130, 160, 195, 230, 270, 312],
  },
];

export interface AnalyticsBreakdown {
  label: string;
  share: number; // 0..1
}

export const mockAnalyticsClients: AnalyticsBreakdown[] = [
  { label: "Claude Desktop", share: 0.41 },
  { label: "Cursor", share: 0.32 },
  { label: "Codex CLI", share: 0.16 },
  { label: "Raycast", share: 0.07 },
  { label: "Other", share: 0.04 },
];

export const mockAnalyticsCommands: AnalyticsBreakdown[] = [
  { label: "analyze-branch", share: 0.38 },
  { label: "agent plan", share: 0.27 },
  { label: "agent packet", share: 0.18 },
  { label: "preflight", share: 0.12 },
  { label: "doctor", share: 0.05 },
];

// ─── Maintainer digest fixtures ──────────────────────────────────────────────

export interface DigestItem {
  kind: "review-now" | "drift" | "install" | "queue" | "summary";
  title: string;
  detail: string;
  meta?: string;
}

export const mockDigest: {
  date: string;
  signal: "ready" | "degraded" | "stale";
  items: DigestItem[];
} = {
  date: "2026-05-30",
  signal: "ready",
  items: [
    {
      kind: "summary",
      title: "Quiet day",
      detail: "4 PRs preflighted, 2 confirmed-miner comments posted, 0 noisy bot replies.",
    },
    {
      kind: "review-now",
      title: "PR #1218 ready to review",
      detail: "Tighten queue-cap copy · linked-issue ok · small diff",
      meta: "demo-miner",
    },
    {
      kind: "queue",
      title: "1 author at queue cap",
      detail: "PR #482 idle 11d — clearing unblocks new scoreable work.",
    },
    {
      kind: "drift",
      title: "Ruleset snapshot rotated",
      detail: "rs_2026_05_28_71d2 → rs_2026_05_29_a1f3 · scoring weights unchanged.",
    },
    {
      kind: "install",
      title: "demo-org webhook lagging",
      detail: "Last event 28h ago — check webhook settings.",
    },
  ],
};

// ─── Browser extension preview fixtures ──────────────────────────────────────

export interface ExtensionPanel {
  label: string;
  badge: string;
  rows: Array<{ k: string; v: string }>;
}

export const mockExtensionPanels: ExtensionPanel[] = [
  {
    label: "Miner context",
    badge: "confirmed",
    rows: [
      { k: "Author", v: "octocat (confirmed)" },
      { k: "Repos active", v: "3 registered" },
      { k: "Lane fit", v: "pursue" },
    ],
  },
  {
    label: "Scoreability",
    badge: "private",
    rows: [
      { k: "Gated today", v: "0.42" },
      { k: "After clean-gate", v: "0.71" },
      { k: "Best reasonable", v: "0.83" },
    ],
  },
  {
    label: "Reviewability",
    badge: "maintainer-only",
    rows: [
      { k: "Bucket", v: "review-now" },
      { k: "Diff size", v: "small" },
      { k: "Duplicate risk", v: "low" },
    ],
  },
];

// ─── AI summary fixtures ─────────────────────────────────────────────────────

export interface AiSummary {
  tool: string;
  summary: string;
  caveat: string;
}

export const mockAiSummaries: Record<string, AiSummary> = {
  "plan-next-work": {
    tool: "plan-next-work",
    summary:
      "Three ranked actions for this account. The top action is to clear PR #482 because the open-PR queue is at cap; the second is to link issue #1204 to the upcoming branch.",
    caveat:
      "Summary is derived strictly from the structured response below. Numbers come from the deterministic plan, not from the model.",
  },
  "explain-blockers": {
    tool: "explain-blockers",
    summary:
      "Two blocker groups are active: a queue-capacity block (1/1 used) and a missing linked-issue on the current branch. Both have one concrete clearing step each.",
    caveat: "Summary mirrors the structured blockers; it never invents codes or counts.",
  },
  "preflight-branch": {
    tool: "preflight-branch",
    summary:
      "Branch addresses issue #1204 and tests were detected, but the linked-issue line is missing from the PR body. Adding it makes the branch scoreable in the next window.",
    caveat: "Scoreability values are private projections, never guarantees.",
  },
  "prepare-pr-packet": {
    tool: "prepare-pr-packet",
    summary:
      'Generated a public-safe packet titled "Add coverage for queue-cap edge case" with the linked issue and area/fixes labels. Nothing in the packet exposes private scoring.',
    caveat: "The packet body is the public surface — review before posting.",
  },
  "public-safe-comment": {
    tool: "public-safe-comment",
    summary:
      "Sticky comment confirms the linked issue and points maintainers at the private blockers command. Contains no scoring or reward language.",
    caveat: "Sticky comments are the only thing Gittensory ever posts publicly.",
  },
};
