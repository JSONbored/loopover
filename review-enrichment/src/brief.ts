// Orchestrator: fan out the enabled analyzers under a time budget, assemble the ReviewBrief, render the prompt
// block. Each analyzer is independent + best-effort — one that throws/times out marks the brief `partial` and the
// others still contribute, so the engine always gets a usable (possibly empty) brief and never blocks on us.
import type {
  EnrichRequest,
  ReviewBrief,
  BriefFindings,
  AnalyzerStatus,
  AnalyzerDiagnostics,
  AnalyzerTelemetry,
} from "./types.js";
import type {
  AnalyzerRegistry,
  AnalyzerRunContext,
  AnalyzerCostClass,
} from "./analyzers/types.js";
import {
  createAnalysisContext,
  type AnalysisContext,
} from "./analysis-context.js";
import { ANALYZERS } from "./analyzers/registry.js";
import { renderBrief } from "./render.js";
import {
  COST_ORDER,
  analyzerTimeoutMs,
  costClassConcurrency,
  planAnalyzers,
  shouldStartAnalyzer,
  type AnalyzerPlanItem,
} from "./scheduler.js";
import { captureAnalyzerDegradation } from "./sentry.js";

const DEFAULT_ANALYZER_TIMEOUT_MS = 8000;
const MIN_ANALYZER_TIMEOUT_MS = 1;
const PUBLIC_PARTIAL_REASON_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

interface BuildBriefOptions {
  requestId?: string;
  traceId?: string;
}

function resolveAnalyzerTimeoutMs(value: number | undefined): number {
  const parsed = Number(value ?? DEFAULT_ANALYZER_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_ANALYZER_TIMEOUT_MS;
  return Math.max(MIN_ANALYZER_TIMEOUT_MS, Math.floor(parsed));
}

function runWithTimeout<T>(
  run: (context: AnalyzerRunContext) => Promise<T>,
  ms: number,
  diagnostics: AnalyzerDiagnostics,
  analysis: AnalysisContext,
  meta: {
    requestDeadlineMs: number;
    profile: AnalyzerRunContext["profile"];
    costClass: AnalyzerCostClass;
  },
): Promise<T> {
  const controller = new AbortController();
  const startedAtMs = Date.now();
  const context: AnalyzerRunContext = {
    signal: controller.signal,
    timeoutMs: ms,
    startedAtMs,
    deadlineMs: startedAtMs + ms,
    requestDeadlineMs: meta.requestDeadlineMs,
    profile: meta.profile,
    costClass: meta.costClass,
    diagnostics,
    analysis,
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      diagnostics.partialStatus = "partial";
      diagnostics.partialReason ??= "analyzer_timeout";
      diagnostics.captureDegradation = true;
      controller.abort();
      reject(new Error("analyzer_timeout"));
    }, ms);
    run(context).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resultIsPartial(result: unknown): boolean {
  if (!Array.isArray(result)) return false;
  return result.some(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      (entry as { partial?: unknown }).partial === true,
  );
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(limit));
  let index = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const item = items[index];
      index += 1;
      if (!item) return;
      await run(item);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
}

function statusFromDiagnostics(
  diagnostics: AnalyzerDiagnostics,
  fallback: AnalyzerStatus,
): AnalyzerStatus {
  if (diagnostics.partialReason === "analyzer_timeout") return "timeout";
  if (diagnostics.capped || diagnostics.externalFailureReason === "call_cap") return "capped";
  return fallback;
}

function timeoutStatus(error: unknown, diagnostics: AnalyzerDiagnostics): AnalyzerStatus {
  if (error instanceof Error && error.message === "analyzer_timeout") return "timeout";
  return statusFromDiagnostics(diagnostics, "degraded");
}

function publicPartialReason(value: string | undefined, fallback: string): string {
  if (value && PUBLIC_PARTIAL_REASON_RE.test(value)) return value;
  return fallback;
}

function captureDegradation(
  error: unknown,
  input: {
    analyzer: keyof BriefFindings;
    requested: Array<keyof BriefFindings>;
    req: EnrichRequest;
    timeoutMs: number;
    elapsedMs: number;
    analyzerStatus: AnalyzerStatus;
    profile: string;
    costClass?: string;
    responseReserveMs?: number;
    diagnostics: AnalyzerDiagnostics;
    options: BuildBriefOptions;
  },
): void {
  captureAnalyzerDegradation(error, {
    analyzer: input.analyzer,
    requestedAnalyzers: input.requested,
    repoFullName: input.req.repoFullName,
    prNumber: input.req.prNumber,
    headSha: input.req.headSha,
    timeoutMs: input.timeoutMs,
    elapsedMs: input.elapsedMs,
    analyzerStatus: input.analyzerStatus,
    profile: input.profile,
    costClass: input.costClass,
    responseReserveMs: input.responseReserveMs,
    partialStatus: input.diagnostics.partialStatus,
    partialReason: input.diagnostics.partialReason,
    phase: input.diagnostics.phase,
    subcall: input.diagnostics.subcall,
    endpointCategory: input.diagnostics.endpointCategory,
    externalFailureReason: input.diagnostics.externalFailureReason,
    externalElapsedMs: input.diagnostics.externalElapsedMs,
    fileLookupCount: input.diagnostics.fileLookupCount,
    commitLookupCount: input.diagnostics.commitLookupCount,
    prLookupCount: input.diagnostics.prLookupCount,
    skippedFileCount: input.diagnostics.skippedFileCount,
    githubEndpointCategory: input.diagnostics.githubEndpointCategory,
    capped: input.diagnostics.capped,
    cacheHits: input.diagnostics.cacheHits,
    cacheMisses: input.diagnostics.cacheMisses,
    externalCallsByCategory: input.diagnostics.externalCallsByCategory,
    skippedWorkByCategory: input.diagnostics.skippedWorkByCategory,
    cappedWorkByCategory: input.diagnostics.cappedWorkByCategory,
    analysisElapsedMs: input.diagnostics.analysisElapsedMs,
    requestId: input.options.requestId,
    traceId: input.options.traceId,
  });
}

function attachAnalysisMetrics(
  diagnostics: AnalyzerDiagnostics,
  analysis: AnalysisContext,
): void {
  const metrics = analysis.snapshotMetrics();
  diagnostics.cacheHits = metrics.cacheHits;
  diagnostics.cacheMisses = metrics.cacheMisses;
  diagnostics.externalCallsByCategory = metrics.externalCallsByCategory;
  diagnostics.skippedWorkByCategory = metrics.skippedWorkByCategory;
  diagnostics.cappedWorkByCategory = metrics.cappedWorkByCategory;
  diagnostics.analysisElapsedMs = metrics.analysisElapsedMs;
}

export async function buildBrief(
  req: EnrichRequest,
  analyzers: AnalyzerRegistry = ANALYZERS,
  options: BuildBriefOptions = {},
): Promise<ReviewBrief> {
  const start = Date.now();
  const all = Object.keys(analyzers) as Array<keyof BriefFindings>;
  const budgetMs = resolveAnalyzerTimeoutMs(req.budget?.timeoutMs);
  const analysis = createAnalysisContext(req, {
    startedAtMs: start,
    deadlineMs: start + budgetMs,
  });
  const plan = planAnalyzers(req, analyzers, analysis, {
    budgetMs,
    startedAtMs: start,
  });

  const findings: BriefFindings = {};
  const analyzerStatus: Record<string, AnalyzerStatus> = {};
  const analyzerTelemetry: Record<string, AnalyzerTelemetry> = {};
  let partial = false;

  for (const item of plan.skipped) {
    analyzerStatus[item.name] = "skipped";
    analyzerTelemetry[item.name] = {
      status: "skipped",
      elapsedMs: 0,
      costClass: item.descriptor.cost,
      skipReason: item.skipReason,
    };
  }

  async function runAnalyzer(item: AnalyzerPlanItem): Promise<void> {
    const name = item.name;
    const analyzerStartedAt = Date.now();
    const diagnostics: AnalyzerDiagnostics = {
      partialStatus: "complete",
    };
    const remainingMs = plan.executionDeadlineMs - Date.now();
    if (!shouldStartAnalyzer(plan.profile, remainingMs)) {
      analyzerStatus[name] = "capped";
      analyzerTelemetry[name] = {
        status: "capped",
        elapsedMs: Date.now() - analyzerStartedAt,
        costClass: item.descriptor.cost,
        partialStatus: "partial",
        partialReason: "analyzer_budget_exhausted",
        capped: true,
      };
      partial = true;
      analysis.metrics.recordCappedWork("analyzer_budget", 1);
      return;
    }
    const timeoutMs = analyzerTimeoutMs(
      plan.profile,
      item.descriptor.cost,
      remainingMs,
      plan.explicitAnalyzers,
    );
    if (timeoutMs <= 0) {
      analyzerStatus[name] = "capped";
      analyzerTelemetry[name] = {
        status: "capped",
        elapsedMs: Date.now() - analyzerStartedAt,
        timeoutMs,
        costClass: item.descriptor.cost,
        partialStatus: "partial",
        partialReason: "analyzer_budget_exhausted",
        capped: true,
      };
      partial = true;
      analysis.metrics.recordCappedWork(`analyzer_${item.descriptor.cost}`, 1);
      return;
    }
    try {
      const analyzer = analyzers[name];
      if (!analyzer) throw new Error("analyzer_unregistered");
      const result = await runWithTimeout(
        (context) => analyzer(req, context),
        timeoutMs,
        diagnostics,
        analysis,
        {
          requestDeadlineMs: plan.executionDeadlineMs,
          profile: plan.profile,
          costClass: item.descriptor.cost,
        },
      );
      findings[name] = result as never;
      if (resultIsPartial(result) || diagnostics.partialStatus === "partial") {
        const status = statusFromDiagnostics(diagnostics, "degraded");
        const partialReason = publicPartialReason(
          diagnostics.partialReason,
          status === "capped" ? "analyzer_capped" : "analyzer_partial",
        );
        analyzerStatus[name] = status;
        analyzerTelemetry[name] = {
          status,
          elapsedMs: Date.now() - analyzerStartedAt,
          timeoutMs,
          costClass: item.descriptor.cost,
          partialStatus: "partial",
          partialReason,
          capped: status === "capped" || diagnostics.capped,
        };
        partial = true;
        diagnostics.partialStatus = "partial";
        diagnostics.partialReason = partialReason;
        if (diagnostics.captureDegradation) {
          attachAnalysisMetrics(diagnostics, analysis);
          captureDegradation(new Error(diagnostics.partialReason), {
            analyzer: name,
            requested: plan.requested,
            req,
            timeoutMs,
            elapsedMs: Date.now() - analyzerStartedAt,
            analyzerStatus: status,
            profile: plan.profile,
            costClass: item.descriptor.cost,
            responseReserveMs: plan.responseReserveMs,
            diagnostics,
            options,
          });
        }
      } else {
        analyzerStatus[name] = "ok";
        analyzerTelemetry[name] = {
          status: "ok",
          elapsedMs: Date.now() - analyzerStartedAt,
          timeoutMs,
          costClass: item.descriptor.cost,
          partialStatus: diagnostics.partialStatus,
        };
      }
    } catch (error) {
      const status = timeoutStatus(error, diagnostics);
      const partialReason = publicPartialReason(diagnostics.partialReason, "analyzer_error");
      analyzerStatus[name] = status;
      analyzerTelemetry[name] = {
        status,
        elapsedMs: Date.now() - analyzerStartedAt,
        timeoutMs,
        costClass: item.descriptor.cost,
        partialStatus: "partial",
        partialReason,
        capped: status === "capped" || diagnostics.capped,
      };
      partial = true;
      diagnostics.partialStatus = "partial";
      diagnostics.partialReason = partialReason;
      attachAnalysisMetrics(diagnostics, analysis);
      captureDegradation(new Error(partialReason), {
        analyzer: name,
        requested: plan.requested,
        req,
        timeoutMs,
        elapsedMs: Date.now() - analyzerStartedAt,
        analyzerStatus: status,
        profile: plan.profile,
        costClass: item.descriptor.cost,
        responseReserveMs: plan.responseReserveMs,
        diagnostics,
        options,
      });
    }
  }

  for (const cost of COST_ORDER) {
    const items = plan.runnable.filter((item) => item.descriptor.cost === cost);
    if (!items.length) continue;
    await runWithConcurrency(
      items,
      costClassConcurrency(plan.profile, cost, plan.explicitAnalyzers),
      runAnalyzer,
    );
  }

  for (const name of all)
    if (!plan.requested.includes(name)) {
      analyzerStatus[name] = "skipped";
      analyzerTelemetry[name] ??= {
        status: "skipped",
        elapsedMs: 0,
        skipReason: "not_requested",
      };
    }

  const { promptSection, systemSuffix } = renderBrief(
    findings,
    req.budget?.maxBriefChars ?? 6000,
  );
  const elapsedMs = Date.now() - start;
  const metrics = analysis.snapshotMetrics();
  const cacheTotal = metrics.cacheHits + metrics.cacheMisses;
  return {
    schemaVersion: 1,
    repoFullName: req.repoFullName,
    prNumber: req.prNumber,
    headSha: req.headSha ?? null,
    generatedAtIso: new Date().toISOString(),
    elapsedMs,
    partial,
    analyzerStatus,
    telemetry: {
      profile: plan.profile,
      responseReserveMs: plan.responseReserveMs,
      requestedAnalyzers: plan.requested,
      analyzerCount: {
        requested: plan.requested.length,
        runnable: plan.runnable.length,
        skipped: plan.skipped.length,
      },
      analyzers: analyzerTelemetry,
      cacheHits: metrics.cacheHits,
      cacheMisses: metrics.cacheMisses,
      cacheHitRate: cacheTotal > 0 ? metrics.cacheHits / cacheTotal : 0,
      externalCallsByCategory: metrics.externalCallsByCategory,
      skippedWorkByCategory: metrics.skippedWorkByCategory,
      cappedWorkByCategory: metrics.cappedWorkByCategory,
      elapsedMs,
    },
    findings,
    promptSection,
    systemSuffix,
  };
}
