import type { AnalysisContext } from "./analysis-context.js";
import { isAnalyzerCircuitOpen } from "./analyzer-circuit-breaker.js";
import {
  ANALYZER_NAMES,
  getAnalyzerDescriptor,
} from "./analyzers/registry.js";
import { isDockerfile } from "./analyzers/eol-check.js";
import type {
  AnalyzerCostClass,
  AnalyzerDescriptor,
  AnalyzerName,
  AnalyzerRegistry,
  AnyAnalyzerDescriptor,
} from "./analyzers/types.js";
import type {
  AnalyzerStatus,
  EnrichRequest,
  ReesProfileName,
} from "./types.js";

export const DEFAULT_REES_PROFILE: ReesProfileName = "balanced";

export const REES_PROFILES = ["fast", "balanced", "deep"] as const satisfies readonly ReesProfileName[];

export const COST_ORDER: readonly AnalyzerCostClass[] = [
  "local",
  "registry",
  "github-light",
  "github-heavy",
  "tooling",
];

const PROFILE_CONFIG: Record<
  ReesProfileName,
  {
    costs: ReadonlySet<AnalyzerCostClass>;
    concurrency: Record<AnalyzerCostClass, number>;
    timeoutMs: Record<AnalyzerCostClass, number>;
    responseReserveMs: number;
    minStartMs: number;
  }
> = {
  fast: {
    costs: new Set(["local", "registry"]),
    concurrency: {
      local: 8,
      registry: 2,
      "github-light": 0,
      "github-heavy": 0,
      tooling: 0,
    },
    timeoutMs: {
      local: 400,
      registry: 800,
      "github-light": 0,
      "github-heavy": 0,
      tooling: 0,
    },
    responseReserveMs: 500,
    minStartMs: 1,
  },
  balanced: {
    costs: new Set(COST_ORDER),
    concurrency: {
      local: 8,
      registry: 3,
      "github-light": 2,
      "github-heavy": 1,
      tooling: 1,
    },
    timeoutMs: {
      local: 750,
      registry: 1400,
      "github-light": 1400,
      "github-heavy": 2200,
      tooling: 1400,
    },
    responseReserveMs: 750,
    minStartMs: 1,
  },
  deep: {
    costs: new Set(COST_ORDER),
    concurrency: {
      local: 8,
      registry: 4,
      "github-light": 2,
      "github-heavy": 1,
      tooling: 1,
    },
    timeoutMs: {
      local: 1000,
      registry: 2500,
      "github-light": 2500,
      "github-heavy": 4000,
      tooling: 2500,
    },
    responseReserveMs: 1000,
    minStartMs: 1,
  },
};

export interface AnalyzerPlanItem {
  name: AnalyzerName;
  descriptor: AnalyzerDescriptor;
  status?: AnalyzerStatus;
  skipReason?: string;
}

export interface AnalyzerPlan {
  profile: ReesProfileName;
  explicitAnalyzers: boolean;
  requested: AnalyzerName[];
  runnable: AnalyzerPlanItem[];
  skipped: AnalyzerPlanItem[];
  responseReserveMs: number;
  executionDeadlineMs: number;
}

export interface ReesProfileMetadata {
  name: ReesProfileName;
  default: boolean;
  costClasses: AnalyzerCostClass[];
  concurrency: Record<AnalyzerCostClass, number>;
  timeoutMs: Record<AnalyzerCostClass, number>;
  responseReserveMs: number;
}

export function resolveReesProfile(value: unknown): ReesProfileName {
  if (typeof value !== "string") return DEFAULT_REES_PROFILE;
  const normalized = value.trim().toLowerCase();
  return isReesProfileName(normalized) ? normalized : DEFAULT_REES_PROFILE;
}

export function isReesProfileName(value: string): value is ReesProfileName {
  return (REES_PROFILES as readonly string[]).includes(value);
}

export function reesProfileMetadata(): ReesProfileMetadata[] {
  return REES_PROFILES.map((name) => {
    const config = PROFILE_CONFIG[name];
    return {
      name,
      default: name === DEFAULT_REES_PROFILE,
      costClasses: COST_ORDER.filter((cost) => config.costs.has(cost)),
      concurrency: { ...config.concurrency },
      timeoutMs: { ...config.timeoutMs },
      responseReserveMs: config.responseReserveMs,
    };
  });
}

export function responseReserveMs(profile: ReesProfileName, budgetMs: number): number {
  const configured = PROFILE_CONFIG[profile].responseReserveMs;
  const proportional = Math.floor(Math.max(0, budgetMs) * 0.2);
  const reserve = Math.min(configured, Math.max(150, proportional));
  return Math.min(Math.max(0, budgetMs - 1), reserve);
}

export function costClassConcurrency(
  profile: ReesProfileName,
  cost: AnalyzerCostClass,
  explicitAnalyzer = false,
): number {
  const configured = Math.max(0, PROFILE_CONFIG[profile].concurrency[cost] ?? 0);
  if (configured > 0 || !explicitAnalyzer) return configured;
  return Math.max(1, PROFILE_CONFIG[DEFAULT_REES_PROFILE].concurrency[cost] ?? 1);
}

export function analyzerTimeoutMs(
  profile: ReesProfileName,
  cost: AnalyzerCostClass,
  remainingMs: number,
  explicitAnalyzer = false,
): number {
  const configured = Math.max(0, PROFILE_CONFIG[profile].timeoutMs[cost] ?? 0);
  const classBudget =
    configured > 0 || !explicitAnalyzer
      ? configured
      : Math.max(0, PROFILE_CONFIG[DEFAULT_REES_PROFILE].timeoutMs[cost] ?? 0);
  return Math.max(0, Math.min(classBudget, Math.floor(remainingMs)));
}

export function shouldStartAnalyzer(
  profile: ReesProfileName,
  remainingMs: number,
): boolean {
  return remainingMs >= PROFILE_CONFIG[profile].minStartMs;
}

export function planAnalyzers(
  req: EnrichRequest,
  analyzers: AnalyzerRegistry,
  analysis: AnalysisContext,
  options: { budgetMs: number; startedAtMs: number },
): AnalyzerPlan {
  const profile = resolveReesProfile(req.profile);
  const explicitAnalyzers = Array.isArray(req.analyzers);
  const configuredReserve = responseReserveMs(profile, options.budgetMs);
  const executionDeadlineMs = options.startedAtMs + options.budgetMs - configuredReserve;
  const allNames = analyzerNamesForRegistry(analyzers);
  const requested = selectRequestedAnalyzers(req, allNames, profile);
  const runnable: AnalyzerPlanItem[] = [];
  const skipped: AnalyzerPlanItem[] = [];

  for (const name of requested) {
    const descriptor = descriptorForAnalyzer(name);
    const skipReason = skipReasonForAnalyzer(
      req,
      analysis,
      descriptor,
      profile,
      explicitAnalyzers,
    );
    if (skipReason) {
      skipped.push({
        name,
        descriptor,
        status: "skipped",
        skipReason,
      });
      analysis.metrics.recordSkippedWork(`analyzer_${skipReason}`);
      continue;
    }
    runnable.push({ name, descriptor });
  }

  runnable.sort(
    (left, right) =>
      COST_ORDER.indexOf(left.descriptor.cost) - COST_ORDER.indexOf(right.descriptor.cost) ||
      allNames.indexOf(left.name) - allNames.indexOf(right.name),
  );

  return {
    profile,
    explicitAnalyzers,
    requested,
    runnable,
    skipped,
    responseReserveMs: configuredReserve,
    executionDeadlineMs,
  };
}

function analyzerNamesForRegistry(analyzers: AnalyzerRegistry): AnalyzerName[] {
  const names = Object.keys(analyzers) as AnalyzerName[];
  return names.sort((left, right) => {
    const leftIndex = ANALYZER_NAMES.indexOf(left);
    const rightIndex = ANALYZER_NAMES.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

function selectRequestedAnalyzers(
  req: EnrichRequest,
  names: readonly AnalyzerName[],
  profile: ReesProfileName,
): AnalyzerName[] {
  if (Array.isArray(req.analyzers)) {
    return names.filter((name) => req.analyzers!.includes(name));
  }
  const config = PROFILE_CONFIG[profile];
  return names.filter((name) => {
    const descriptor = descriptorForAnalyzer(name);
    return descriptor.defaultEnabled && config.costs.has(descriptor.cost);
  });
}

function descriptorForAnalyzer(name: AnalyzerName): AnalyzerDescriptor {
  const descriptor = getAnalyzerDescriptor(name);
  if (descriptor) return descriptor as AnalyzerDescriptor;
  return {
    name,
    title: name,
    category: "quality",
    cost: "local",
    defaultEnabled: true,
    requires: [],
    docs: {
      summary: "Custom analyzer supplied by a caller.",
      looksAt: "Caller-provided inputs.",
      reports: "Caller-defined findings.",
      network: "Unknown.",
      notes: "Synthetic descriptor used for tests or injected registries.",
    },
    run: async () => [] as never,
  };
}

function skipReasonForAnalyzer(
  req: EnrichRequest,
  analysis: AnalysisContext,
  descriptor: AnyAnalyzerDescriptor | AnalyzerDescriptor,
  profile: ReesProfileName,
  explicitAnalyzers: boolean,
): string | null {
  if (!explicitAnalyzers && !PROFILE_CONFIG[profile].costs.has(descriptor.cost)) return "profile";
  if (!explicitAnalyzers && costClassConcurrency(profile, descriptor.cost) <= 0) return "profile";

  if (
    descriptor.requires.includes("files") &&
    analysis.changedFiles.length === 0 &&
    !historyCanRunWithoutGitHub(req, descriptor.name)
  ) {
    return "no_files";
  }
  if (descriptor.requires.includes("head-sha") && !req.headSha) {
    return "missing_head_sha";
  }
  if (descriptor.requires.includes("base-sha") && !req.baseSha) {
    return "missing_base_sha";
  }
  if (descriptor.requires.includes("author") && !req.author && descriptor.name !== "history") {
    return "missing_author";
  }
  if (
    descriptor.requires.includes("github-token") &&
    !req.githubToken &&
    !historyCanRunWithoutGitHub(req, descriptor.name)
  ) {
    return "missing_github_token";
  }

  const inputSkip = inputSkipReason(descriptor.name, analysis, req);
  if (inputSkip) return inputSkip;

  // #2541: checked LAST, only once every other skip reason has cleared -- isAnalyzerCircuitOpen claims a
  // single half-open probe as a side effect when the cooldown has expired, and that claim is only ever
  // released inside runAnalyzer (brief.ts), which never runs for a plan.skipped item. Checking this any
  // earlier could claim the probe for an analyzer that's about to be skipped for an UNRELATED reason (a
  // missing head SHA, no dependency manifest, etc.), leaking the claim forever with no outcome ever recorded.
  // An EXPLICIT request (req.analyzers) does not bypass this -- the circuit is about the dependency being
  // down right now, which an explicit request can't fix.
  if (isAnalyzerCircuitOpen(descriptor.name, req)) return "circuit_open";

  return null;
}

function inputSkipReason(
  name: AnalyzerName,
  analysis: AnalysisContext,
  req: EnrichRequest,
): string | null {
  switch (name) {
    case "dependency":
    case "license":
    case "installScript":
    case "heavyDependency":
    case "typosquat":
    case "nativeBuild":
      return analysis.dependencyManifestPaths.length ? null : "no_dependency_manifest";
    case "lockfileDrift":
      return analysis.fileCategories.some((file) => file.category === "lockfile")
        ? null
        : "no_lockfile";
    case "actionPin":
      return analysis.fileCategories.some((file) => file.category === "workflow")
        ? null
        : "no_workflow";
    case "eol":
      return analysis.changedFilePaths.some(isRuntimePinPath) ? null : "no_runtime_pin";
    case "redos":
    case "secret":
    case "secretLog":
      return analysis.hasAddedLines ? null : "no_added_lines";
    case "provenance":
      return analysis.dependencyManifestPaths.length ||
        analysis.changedFiles.some((file) => file.status === "added" || file.status === "copied")
        ? null
        : "no_provenance_input";
    case "codeowners":
      return analysis.changedFilePaths.length ? null : "no_changed_paths";
    case "assetWeight":
      return analysis.fileCategories.some((file) => file.category === "asset")
        ? null
        : "no_asset_paths";
    case "commitSignature":
      return null;
    case "iacMisconfig":
      return analysis.fileCategories.some((file) => file.category === "config")
        ? null
        : "no_config_paths";
    case "history":
      if (historyCanRunWithoutGitHub(req, name)) return null;
      return req.githubToken && req.author && analysis.changedFilePaths.length
        ? null
        : "no_history_input";
    default:
      return null;
  }
}

function historyCanRunWithoutGitHub(
  req: EnrichRequest,
  name: AnalyzerName,
): boolean {
  return name === "history" && Boolean(req.linkedIssue && (req.diff || req.files?.length));
}

function isRuntimePinPath(path: string): boolean {
  const basename = path.split("/").pop() ?? path;
  // Share the eol analyzer's own Dockerfile predicate so the gate can't skip a file the analyzer would
  // parse. The prior bespoke `/^Dockerfile(?:\..*)?$/` missed `*.dockerfile` (e.g. web.dockerfile), silently
  // dropping eol analysis for it even though isDockerfile() handles it.
  // Version-manager pin files (nodenv/pyenv/rbenv/phpenv/goenv and asdf) the eol analyzer parses.
  return (
    isDockerfile(path) ||
    basename === ".nvmrc" ||
    basename === ".node-version" ||
    basename === ".python-version" ||
    basename === ".ruby-version" ||
    basename === ".php-version" ||
    basename === ".go-version" ||
    basename === ".rust-version" ||
    basename === ".java-version" ||
    basename === ".terraform-version" ||
    basename === ".elixir-version" ||
    basename === ".kotlin-version" ||
    basename === ".tool-versions" ||
    basename === "go.mod"
  );
}
