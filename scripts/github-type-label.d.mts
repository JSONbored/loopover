export type TypeLabel = "bug" | "feature";

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
export function getTypeLabelDecision(eventName: string, payload: unknown): TypeLabelDecision;
export function readCurrentLabels(options: {
  issueLabelsUrl: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<string[]>;
export function applyTypeLabel(options: {
  apiUrl?: string;
  repository: string;
  token: string;
  number: number;
  label: TypeLabel;
  fetchImpl?: typeof fetch;
}): Promise<{ applied: boolean; reason?: string }>;
export function main(): Promise<void>;
