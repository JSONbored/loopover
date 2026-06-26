// Orchestrator: fan out the enabled analyzers under a time budget, assemble the ReviewBrief, render the prompt
// block. Each analyzer is independent + best-effort — one that throws/times out marks the brief `partial` and the
// others still contribute, so the engine always gets a usable (possibly empty) brief and never blocks on us.
import type {
  EnrichRequest,
  ReviewBrief,
  BriefFindings,
  AnalyzerStatus,
} from "./types.js";
import { scanDependencies } from "./analyzers/dependency-scan.js";
import { scanSecrets } from "./analyzers/secret-scan.js";
import { renderBrief } from "./render.js";

type AnalyzerFn = (req: EnrichRequest) => Promise<unknown>;

// The analyzer registry. More land behind this same shape: license (#1475), secret (#1476), static (#1477), history (#1478).
const ANALYZERS: Record<keyof BriefFindings, AnalyzerFn> = {
  dependency: (req) => scanDependencies(req),
  secret: (req) => scanSecrets(req),
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("analyzer_timeout")), ms);
    promise.then(
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

export async function buildBrief(req: EnrichRequest): Promise<ReviewBrief> {
  const start = Date.now();
  const all = Object.keys(ANALYZERS) as Array<keyof BriefFindings>;
  const requested = req.analyzers?.length
    ? all.filter((name) => req.analyzers!.includes(name))
    : all;
  const budgetMs = req.budget?.timeoutMs ?? 8000;

  const findings: BriefFindings = {};
  const analyzerStatus: Record<string, AnalyzerStatus> = {};
  let partial = false;

  await Promise.all(
    requested.map(async (name) => {
      try {
        const result = await withTimeout(ANALYZERS[name](req), budgetMs);
        findings[name] = result as never;
        analyzerStatus[name] = "ok";
      } catch {
        analyzerStatus[name] = "degraded";
        partial = true;
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
