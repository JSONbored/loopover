import type {
  AnalyzerDiagnostics,
  BriefFindings,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import type { AnalyzerRenderHelpers } from "../render-helpers.js";

export type AnalyzerName = keyof BriefFindings;

export type AnalyzerCategory =
  | "security"
  | "supply-chain"
  | "ownership"
  | "history"
  | "quality"
  | "performance"
  | "config";

export type AnalyzerCostClass =
  | "local"
  | "registry"
  | "github-light"
  | "github-heavy"
  | "tooling";

export type AnalyzerRequirement =
  | "diff"
  | "files"
  | "public-network"
  | "github-token"
  | "head-sha"
  | "base-sha"
  | "author"
  | "linked-issue";

export interface AnalyzerRunContext {
  signal: AbortSignal;
  timeoutMs: number;
  startedAtMs: number;
  deadlineMs: number;
  diagnostics: AnalyzerDiagnostics;
  analysis: AnalysisContext;
}

export type AnalyzerResult<Name extends AnalyzerName = AnalyzerName> =
  NonNullable<BriefFindings[Name]>;

export type AnalyzerFn = (
  req: EnrichRequest,
  context: AnalyzerRunContext,
) => Promise<unknown>;

export type AnalyzerRegistry = Partial<Record<AnalyzerName, AnalyzerFn>>;

export interface AnalyzerDocs {
  summary: string;
  looksAt: string;
  reports: string;
  network: string;
  notes: string;
}

export interface AnalyzerDescriptor<Name extends AnalyzerName = AnalyzerName> {
  name: Name;
  title: string;
  category: AnalyzerCategory;
  cost: AnalyzerCostClass;
  defaultEnabled: boolean;
  requires: AnalyzerRequirement[];
  limits?: Record<string, number>;
  docs: AnalyzerDocs;
  run: (
    req: EnrichRequest,
    context: AnalyzerRunContext,
  ) => Promise<AnalyzerResult<Name>>;
  render?: (
    result: AnalyzerResult<Name>,
    helpers: AnalyzerRenderHelpers,
  ) => string[];
}

export type AnyAnalyzerDescriptor = {
  [Name in AnalyzerName]: AnalyzerDescriptor<Name>;
}[AnalyzerName];
