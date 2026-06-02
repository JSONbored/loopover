export const PLAYGROUND_TOOLS = [
  { id: "plan-next-work", label: "Plan next work" },
  { id: "explain-blockers", label: "Explain blockers" },
  { id: "preflight-branch", label: "Preflight branch" },
  { id: "prepare-pr-packet", label: "Prepare PR packet" },
  { id: "decision-pack", label: "Decision pack" },
  { id: "repo-intelligence", label: "Repo intelligence" },
  { id: "branch-analysis", label: "Branch analysis (metadata)" },
  { id: "maintainer-packet", label: "Maintainer PR packet" },
  { id: "public-safe-comment", label: "Public-safe comment preview" },
] as const;

export type PlaygroundToolId = (typeof PLAYGROUND_TOOLS)[number]["id"];

export const PLAYGROUND_SCENARIOS = [
  { id: "gated", label: "Gated today" },
  { id: "after-pending", label: "After pending merges" },
  { id: "clean", label: "Clean-gate" },
  { id: "best-reasonable", label: "Best reasonable" },
] as const;

export type PlaygroundScenarioId = (typeof PLAYGROUND_SCENARIOS)[number]["id"];

export interface PlaygroundRunInput {
  tool: PlaygroundToolId;
  login: string;
  repoFullName: string;
  branchName: string;
  scenario: PlaygroundScenarioId;
  pullNumber?: number;
}

export interface PlaygroundHttpRequest {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

function splitRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`repoFullName must be owner/repo, got "${repoFullName}"`);
  }
  return { owner, repo };
}

/** Metadata-only branch analysis sample — no source file contents. */
export function sampleBranchAnalysisBody(input: Pick<PlaygroundRunInput, "login" | "repoFullName" | "branchName" | "scenario">) {
  return {
    login: input.login,
    repoFullName: input.repoFullName,
    baseRef: "origin/main",
    headRef: input.branchName,
    branchName: input.branchName,
    title: `Playground branch analysis (${input.scenario})`,
    body: "Fixes #1",
    labels: ["enhancement"],
    changedFiles: [
      { path: "src/example.ts", additions: 12, deletions: 2, status: "modified" as const },
      { path: "test/example.test.ts", additions: 8, deletions: 0, status: "added" as const },
    ],
    validation: [{ command: "npm test", status: "passed" as const, summary: "playground metadata sample" }],
  };
}

export function buildPlaygroundRequest(input: PlaygroundRunInput): PlaygroundHttpRequest {
  const { owner, repo } = splitRepoFullName(input.repoFullName);
  switch (input.tool) {
    case "public-safe-comment":
      return {
        method: "POST",
        path: "/v1/app/commands/preview",
        body: {
          command: "public-summary",
          repoFullName: input.repoFullName,
          login: input.login,
        },
      };
    case "decision-pack":
      return {
        method: "GET",
        path: `/v1/contributors/${encodeURIComponent(input.login)}/decision-pack`,
      };
    case "repo-intelligence":
      return {
        method: "GET",
        path: `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/intelligence`,
      };
    case "branch-analysis":
      return {
        method: "POST",
        path: "/v1/local/branch-analysis",
        body: sampleBranchAnalysisBody(input),
      };
    case "maintainer-packet": {
      const number = input.pullNumber ?? 1;
      return {
        method: "GET",
        path: `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/maintainer-packet`,
      };
    }
    case "plan-next-work":
    case "explain-blockers":
      return {
        method: "POST",
        path:
          input.tool === "plan-next-work" ? "/v1/agent/plan-next-work" : "/v1/agent/explain-blockers",
        body: {
          login: input.login,
          repoFullName: input.repoFullName,
          surface: "api",
          objective: `${input.tool} for ${input.repoFullName}`,
        },
      };
    case "preflight-branch":
    case "prepare-pr-packet":
      return {
        method: "POST",
        path:
          input.tool === "preflight-branch"
            ? "/v1/agent/preflight-branch"
            : "/v1/agent/prepare-pr-packet",
        body: {
          login: input.login,
          repoFullName: input.repoFullName,
          branchName: input.branchName,
          headRef: input.branchName,
          title: `${input.tool} preview`,
          scenarioNotes: [input.scenario],
        },
      };
    default: {
      const _exhaustive: never = input.tool;
      throw new Error(`Unknown playground tool: ${String(_exhaustive)}`);
    }
  }
}

export function playgroundToolUsesScenario(tool: PlaygroundToolId): boolean {
  return tool === "preflight-branch" || tool === "plan-next-work";
}

export function playgroundToolUsesPullNumber(tool: PlaygroundToolId): boolean {
  return tool === "maintainer-packet";
}
