// Orchestrator: fan out the enabled analyzers under a time budget, assemble the ReviewBrief, render the prompt
// block. Each analyzer is independent + best-effort — one that throws/times out marks the brief `partial` and the
// others still contribute, so the engine always gets a usable (possibly empty) brief and never blocks on us.
import type {
  EnrichRequest,
  ReviewBrief,
  BriefFindings,
  AnalyzerStatus,
  AnalyzerDiagnostics,
} from "./types.js";
import type {
  AnalyzerRegistry,
  AnalyzerRunContext,
} from "./analyzers/types.js";
import { ANALYZERS } from "./analyzers/registry.js";
import { renderBrief } from "./render.js";
import { captureAnalyzerDegradation } from "./sentry.js";

const DEFAULT_ANALYZER_TIMEOUT_MS = 8000;
const MIN_ANALYZER_TIMEOUT_MS = 1;

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
): Promise<T> {
  const controller = new AbortController();
  const startedAtMs = Date.now();
  const context: AnalyzerRunContext = {
    signal: controller.signal,
    timeoutMs: ms,
    startedAtMs,
    deadlineMs: startedAtMs + ms,
    diagnostics,
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

function captureDegradation(
  error: unknown,
  input: {
    analyzer: keyof BriefFindings;
    requested: Array<keyof BriefFindings>;
    req: EnrichRequest;
    timeoutMs: number;
    elapsedMs: number;
    analyzerStatus: AnalyzerStatus;
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
    partialStatus: input.diagnostics.partialStatus,
    partialReason: input.diagnostics.partialReason,
    phase: input.diagnostics.phase,
    subcall: input.diagnostics.subcall,
    fileLookupCount: input.diagnostics.fileLookupCount,
    commitLookupCount: input.diagnostics.commitLookupCount,
    prLookupCount: input.diagnostics.prLookupCount,
    skippedFileCount: input.diagnostics.skippedFileCount,
    githubEndpointCategory: input.diagnostics.githubEndpointCategory,
    capped: input.diagnostics.capped,
    requestId: input.options.requestId,
    traceId: input.options.traceId,
  });
}

export async function buildBrief(
  req: EnrichRequest,
  analyzers: AnalyzerRegistry = ANALYZERS,
  options: BuildBriefOptions = {},
): Promise<ReviewBrief> {
  const start = Date.now();
  const all = Object.keys(analyzers) as Array<keyof BriefFindings>;
  const requested = Array.isArray(req.analyzers)
    ? all.filter((name) => req.analyzers!.includes(name))
    : all;
  const budgetMs = resolveAnalyzerTimeoutMs(req.budget?.timeoutMs);

  const findings: BriefFindings = {};
  const analyzerStatus: Record<string, AnalyzerStatus> = {};
  let partial = false;

  await Promise.all(
    requested.map(async (name) => {
      const analyzerStartedAt = Date.now();
      const diagnostics: AnalyzerDiagnostics = {
        partialStatus: "complete",
      };
      try {
        const analyzer = analyzers[name];
        if (!analyzer) throw new Error("analyzer_unregistered");
        const result = await runWithTimeout(
          (context) => analyzer(req, context),
          budgetMs,
          diagnostics,
        );
        findings[name] = result as never;
        if (resultIsPartial(result)) {
          analyzerStatus[name] = "degraded";
          partial = true;
          diagnostics.partialStatus = "partial";
          diagnostics.partialReason ??= "analyzer_partial";
          if (diagnostics.captureDegradation) {
            captureDegradation(new Error(diagnostics.partialReason), {
              analyzer: name,
              requested,
              req,
              timeoutMs: budgetMs,
              elapsedMs: Date.now() - analyzerStartedAt,
              analyzerStatus: "degraded",
              diagnostics,
              options,
            });
          }
        } else {
          analyzerStatus[name] = "ok";
        }
      } catch (error) {
        analyzerStatus[name] = "degraded";
        partial = true;
        diagnostics.partialStatus = "partial";
        diagnostics.partialReason ??= error instanceof Error ? error.message : "analyzer_error";
        captureDegradation(error, {
          analyzer: name,
          requested,
          req,
          timeoutMs: budgetMs,
          elapsedMs: Date.now() - analyzerStartedAt,
          analyzerStatus: "degraded",
          diagnostics,
          options,
        });
      }
    }),
  );
  for (const name of all)
    if (!requested.includes(name)) analyzerStatus[name] = "skipped";

  const { promptSection, systemSuffix } = renderBrief(
    findings,
    req.budget?.maxBriefChars ?? 6000,
  );
  return {
    schemaVersion: 1,
    repoFullName: req.repoFullName,
    prNumber: req.prNumber,
    headSha: req.headSha ?? null,
    generatedAtIso: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    partial,
    analyzerStatus,
    findings,
    promptSection,
    systemSuffix,
  };
}
