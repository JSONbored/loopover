import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

export const MCP_PLANNING_ELICITATION_FIELDS = [
  "repoFullName",
  "contributionLane",
  "timeHorizon",
  "riskAppetite",
  "cleanupFirst",
] as const;

export type McpPlanningElicitationField = (typeof MCP_PLANNING_ELICITATION_FIELDS)[number];

export type McpPlanningChoices = Partial<{
  repoFullName: string;
  contributionLane: "any" | "direct_pr" | "issue_discovery" | "cleanup";
  timeHorizon: "today" | "this_week" | "this_month";
  riskAppetite: "low" | "medium" | "high";
  cleanupFirst: boolean;
}>;

export type McpPlanningElicitationAudit = {
  supported: boolean;
  requested: boolean;
  accepted: boolean;
  fields: McpPlanningElicitationField[];
};

export type McpAgentPlanInput = {
  login: string;
  objective?: string | undefined;
  repoFullName?: string | undefined;
};

const CONTRIBUTION_LANES = ["any", "direct_pr", "issue_discovery", "cleanup"] as const;
const TIME_HORIZONS = ["today", "this_week", "this_month"] as const;
const RISK_APPETITES = ["low", "medium", "high"] as const;
const REPO_FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SENSITIVE_FIELD_RE =
  /\b(token|secret|wallet|hotkey|coldkey|private\s*keys?|pat|mnemonic|seed\s*phrase|private\s*maintainer\s*evidence)\b/i;

function enumChoice<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function stringChoice(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || SENSITIVE_FIELD_RE.test(normalized)) return undefined;
  return normalized;
}

export function buildMcpPlanningElicitationRequest(): ElicitRequestFormParams {
  return {
    mode: "form",
    message: "Choose optional public planning preferences for ranking Gittensory contribution work.",
    requestedSchema: {
      type: "object",
      properties: {
        repoFullName: {
          type: "string",
          title: "Repository",
          description: "Optional public GitHub repository in owner/name form.",
          minLength: 3,
          maxLength: 120,
        },
        contributionLane: {
          type: "string",
          title: "Contribution lane",
          description: "Preferred kind of public contribution work.",
          enum: [...CONTRIBUTION_LANES],
          default: "any",
        },
        timeHorizon: {
          type: "string",
          title: "Time horizon",
          description: "How soon the contribution should be practical.",
          enum: [...TIME_HORIZONS],
          default: "this_week",
        },
        riskAppetite: {
          type: "string",
          title: "Risk appetite",
          description: "Preferred review and implementation risk level.",
          enum: [...RISK_APPETITES],
          default: "medium",
        },
        cleanupFirst: {
          type: "boolean",
          title: "Prefer cleanup first",
          description: "Prefer small cleanup or stabilization work before larger features.",
          default: false,
        },
      },
      required: [],
    },
  };
}

export function validateMcpPlanningElicitationRequest(request: ElicitRequestFormParams): void {
  const fieldNames = Object.keys(request.requestedSchema.properties);
  const expected = new Set<string>(MCP_PLANNING_ELICITATION_FIELDS);
  const unexpected = fieldNames.filter((field) => !expected.has(field));
  const missing = MCP_PLANNING_ELICITATION_FIELDS.filter((field) => !fieldNames.includes(field));
  const serialized = JSON.stringify(request);
  if (unexpected.length > 0 || missing.length > 0 || SENSITIVE_FIELD_RE.test(serialized)) {
    throw new Error("Unsafe MCP planning elicitation request.");
  }
}

export function planningChoicesFromElicitationResult(result: ElicitResult): McpPlanningChoices {
  if (result.action !== "accept" || !result.content) return {};
  const content = result.content;
  const choices: McpPlanningChoices = {};
  const repoFullName = stringChoice(content.repoFullName, 120);
  if (repoFullName && REPO_FULL_NAME_RE.test(repoFullName)) choices.repoFullName = repoFullName;
  const contributionLane = enumChoice(content.contributionLane, CONTRIBUTION_LANES);
  if (contributionLane) choices.contributionLane = contributionLane;
  const timeHorizon = enumChoice(content.timeHorizon, TIME_HORIZONS);
  if (timeHorizon) choices.timeHorizon = timeHorizon;
  const riskAppetite = enumChoice(content.riskAppetite, RISK_APPETITES);
  if (riskAppetite) choices.riskAppetite = riskAppetite;
  if (typeof content.cleanupFirst === "boolean") choices.cleanupFirst = content.cleanupFirst;
  return choices;
}

export function applyMcpPlanningChoices(input: McpAgentPlanInput, choices: McpPlanningChoices): McpAgentPlanInput {
  const output: McpAgentPlanInput = { ...input };
  if (!output.repoFullName && choices.repoFullName) output.repoFullName = choices.repoFullName;
  if (!output.objective && hasPlanningChoices(choices)) {
    const parts = [
      choices.repoFullName ? `repo ${choices.repoFullName}` : undefined,
      choices.contributionLane ? `lane ${choices.contributionLane}` : undefined,
      choices.timeHorizon ? `time horizon ${choices.timeHorizon}` : undefined,
      choices.riskAppetite ? `risk appetite ${choices.riskAppetite}` : undefined,
      choices.cleanupFirst === true ? "prefer cleanup first" : choices.cleanupFirst === false ? "cleanup first optional" : undefined,
    ].filter(Boolean);
    output.objective = `Plan the next Gittensor OSS contribution action with ${parts.join(", ")}.`;
  }
  return output;
}

export function buildMcpPlanningElicitationAudit(
  input: { supported: boolean; requested: boolean; accepted: boolean },
  choices: McpPlanningChoices,
): McpPlanningElicitationAudit {
  return {
    supported: input.supported,
    requested: input.requested,
    accepted: input.accepted,
    fields: MCP_PLANNING_ELICITATION_FIELDS.filter((field) => choices[field] !== undefined),
  };
}

function hasPlanningChoices(choices: McpPlanningChoices): boolean {
  return MCP_PLANNING_ELICITATION_FIELDS.some((field) => choices[field] !== undefined);
}
