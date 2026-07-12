import { GITTENSOR_HOME_URL, GITTENSORY_SITE_URL } from "../github/footer";
import { GITTENSORY_MCP_PACKAGE_NAME, LATEST_RECOMMENDED_MCP_VERSION, MINIMUM_SUPPORTED_MCP_VERSION } from "./mcp-compatibility";

// Gittensor is Bittensor subnet 74 (the code subnet). Gittensory is its contribution interface.
export const GITTENSOR_NETUID = 74;
const DEFAULT_GITTENSOR_UPSTREAM_REPO = "entrius/gittensor";
const SUBNET_INTERFACE_SCHEMA_VERSION = "1.0";
// The publicly installable GitHub App maintainers add to a gittensor-registered repo (#695's onboarding step
// below). Hardcoded like the other product-identity constants in this file (not env-driven): it's the same
// stable, real app across every deployment of this descriptor, independent of which credentials any one
// Worker instance happens to hold for its own operational purposes.
const PUBLIC_GITHUB_APP_SLUG = "gittensory-orb";

// Curated, contribution-relevant MCP tools surfaced to agents/devs who discover gittensor via metagraphed.
// Names mirror src/mcp/server.ts registrations; the list is intentionally a miner-facing subset (not all 33).
const CONTRIBUTION_MCP_TOOLS: ReadonlyArray<{ name: string; summary: string }> = [
  { name: "gittensory_get_decision_pack", summary: "Surface contribution candidates across registered repos with duplicate-risk context." },
  { name: "gittensory_check_before_start", summary: "Check whether an issue is already claimed or solved before writing code." },
  { name: "gittensory_validate_linked_issue", summary: "Confirm whether a planned PR has a linked issue before opening it." },
  { name: "gittensory_preflight_pr", summary: "Preflight a planned PR for lane fit, duplicate risk, and review burden." },
  { name: "gittensory_monitor_open_prs", summary: "Track your open PRs and what to clean up first." },
  { name: "gittensory_get_pr_ai_review_findings", summary: "Read structured AI-review findings on your submitted PR (category, path, severity)." },
  { name: "gittensory_list_notifications", summary: "See review feedback (e.g. changes requested) on your PRs." },
  { name: "gittensory_agent_plan_next_work", summary: "Suggest useful next gittensor contribution actions from current repo and PR context." },
];

const ONBOARDING_STEPS: ReadonlyArray<string> = [
  "Maintainers: install the Gittensory GitHub App on a gittensor-registered repository.",
  "Contributors (miners): connect the Gittensory MCP endpoint in your agent harness (Claude Code, Cursor, etc.).",
  "Use gittensory_get_decision_pack to find high-fit, low-duplicate issues, then gittensory_check_before_start before writing code.",
  "Preflight with gittensory_preflight_pr and open a focused PR linked to its issue.",
];

export type SubnetInterfaceDescriptor = {
  schemaVersion: string;
  generatedAt: string;
  subnet: { netuid: number; name: string; home: string; upstreamRepo: string };
  provider: { name: string; role: "contribution_interface"; site: string; summary: string };
  interfaces: {
    mcp: {
      kind: "mcp";
      transport: "http";
      endpoint: string;
      package: string;
      minimumVersion: string;
      recommendedVersion: string;
      tools: Array<{ name: string; summary: string }>;
    };
    githubApp: { kind: "github_app"; slug: string; installUrl: string };
  };
  onboarding: { docs: string; steps: string[] };
};

/**
 * Machine-readable descriptor declaring Gittensory as gittensor (subnet 74)'s contribution interface, so
 * metagraphed (and any agent) can route discovery → contribution (#695). Pure product metadata (URLs, tool
 * names) — no private/reward/score wording, so it never needs sanitization. Public + unauthenticated.
 */
export function buildSubnetInterfaceDescriptor(args: { origin: string; generatedAt: string; upstreamRepo?: string | undefined }): SubnetInterfaceDescriptor {
  const origin = args.origin.replace(/\/+$/, "");
  return {
    schemaVersion: SUBNET_INTERFACE_SCHEMA_VERSION,
    generatedAt: args.generatedAt,
    subnet: {
      netuid: GITTENSOR_NETUID,
      name: "gittensor",
      home: GITTENSOR_HOME_URL,
      upstreamRepo: args.upstreamRepo ?? DEFAULT_GITTENSOR_UPSTREAM_REPO,
    },
    provider: {
      name: "Gittensory",
      role: "contribution_interface",
      site: GITTENSORY_SITE_URL,
      summary: "Gittensor-native contribution planning layer: MCP guidance for contributors and a free anti-slop + AI second-opinion gate for maintainers.",
    },
    interfaces: {
      mcp: {
        kind: "mcp",
        transport: "http",
        endpoint: `${origin}/mcp`,
        package: GITTENSORY_MCP_PACKAGE_NAME,
        minimumVersion: MINIMUM_SUPPORTED_MCP_VERSION,
        recommendedVersion: LATEST_RECOMMENDED_MCP_VERSION,
        tools: CONTRIBUTION_MCP_TOOLS.map((tool) => ({ ...tool })),
      },
      githubApp: {
        kind: "github_app",
        slug: PUBLIC_GITHUB_APP_SLUG,
        installUrl: `https://github.com/apps/${PUBLIC_GITHUB_APP_SLUG}`,
      },
    },
    onboarding: {
      docs: GITTENSORY_SITE_URL,
      steps: [...ONBOARDING_STEPS],
    },
  };
}
