export type TypeLabel = "gittensor:bug" | "gittensor:feature";

export type IssueReference = {
  number?: number;
  title?: string;
  labels?: unknown;
  pull_request?: unknown;
};

export type TypeLabelDecision =
  | {
      action: "apply";
      label: TypeLabel;
      number: number;
      title: string;
    }
  | {
      action: "skip";
      reason: string;
      number?: number;
      title?: string;
      label?: TypeLabel;
    };

export function normalizeLabels(labels: unknown): string[];
export function classifyTypeLabel(title: string, labels?: unknown): TypeLabel | null;
export function getTypeLabelDecision(
  eventName: string,
  payload: unknown,
  options?: { issueReferences?: IssueReference[] },
): TypeLabelDecision;
export function readCurrentLabels(options: {
  issueLabelsUrl: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<string[]>;
export function ensureRepositoryLabel(options: {
  apiUrl?: string;
  owner: string;
  repo: string;
  headers: Record<string, string>;
  label: TypeLabel;
  fetchImpl?: typeof fetch;
}): Promise<{ created: boolean; reason?: string }>;
export function extractClosingIssueNumbers(text: unknown): number[];
export function fetchReferencedIssues(options: {
  apiUrl?: string;
  repository: string;
  token: string;
  body: unknown;
  fetchImpl?: typeof fetch;
}): Promise<IssueReference[]>;
export function applyTypeLabel(options: {
  apiUrl?: string;
  repository: string;
  token: string;
  number: number;
  label: TypeLabel;
  fetchImpl?: typeof fetch;
}): Promise<{ applied: boolean; reason?: string }>;
export function main(): Promise<void>;
