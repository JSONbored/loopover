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
import { scanLockfileDrift } from "./analyzers/lockfile-drift.js";
import { scanSecrets } from "./analyzers/secret-scan.js";
import { scanLicenses } from "./analyzers/license-check.js";
import { scanInstallScripts } from "./analyzers/install-scripts.js";
import { scanHeavyDependencies } from "./analyzers/heavy-dependency.js";
import { scanActionPins } from "./analyzers/actions-pin.js";
import { scanEol } from "./analyzers/eol-check.js";
import { scanRedos } from "./analyzers/redos.js";
import { scanProvenance } from "./analyzers/provenance.js";
import { scanCodeowners } from "./analyzers/codeowners.js";
import { scanSecretLog } from "./analyzers/secret-log.js";
import { scanAssetWeight } from "./analyzers/asset-weight.js";
import { scanTyposquat } from "./analyzers/typosquat.js";
import { scanIacMisconfig } from "./analyzers/iac-misconfig.js";
import { scanNativeBuild } from "./analyzers/native-build.js";
import { scanHistory } from "./analyzers/history.js";
import { renderBrief } from "./render.js";
import { captureAnalyzerDegradation } from "./sentry.js";

type AnalyzerFn = (req: EnrichRequest, signal: AbortSignal) => Promise<unknown>;
type AnalyzerRegistry = Partial<Record<keyof BriefFindings, AnalyzerFn>>;

// The analyzer registry. Each key is the exact name accepted by the engine's REES_ANALYZERS setting.
const ANALYZERS: Record<keyof BriefFindings, AnalyzerFn> = {
  dependency: (req, signal) => scanDependencies(req, fetch, { signal }),
  lockfileDrift: (req, signal) => scanLockfileDrift(req, fetch, { signal }),
  secret: (req) => scanSecrets(req),
  license: (req) => scanLicenses(req),
  installScript: (req) => scanInstallScripts(req),
  heavyDependency: (req, signal) =>
    scanHeavyDependencies(req, fetch, { signal }),
  actionPin: (req) => scanActionPins(req),
  eol: (req) => scanEol(req),
  redos: (req) => scanRedos(req),
  provenance: (req, signal) => scanProvenance(req, fetch, { signal }),
  codeowners: (req, signal) => scanCodeowners(req, fetch, { signal }),
  secretLog: (req, signal) => scanSecretLog(req, signal),
  assetWeight: (req, signal) => scanAssetWeight(req, fetch, { signal }),
  typosquat: (req, signal) => scanTyposquat(req, fetch, { signal }),
  iacMisconfig: (req, signal) => scanIacMisconfig(req, signal),
  nativeBuild: (req, signal) => scanNativeBuild(req, fetch, { signal }),
  history: (req, signal) => scanHistory(req, fetch, { signal }),
};

function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("analyzer_timeout"));
    }, ms);
    run(controller.signal).then(
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

export async function buildBrief(
  req: EnrichRequest,
  analyzers: AnalyzerRegistry = ANALYZERS,
): Promise<ReviewBrief> {
  const start = Date.now();
  const all = Object.keys(analyzers) as Array<keyof BriefFindings>;
  const requested = Array.isArray(req.analyzers)
    ? all.filter((name) => req.analyzers!.includes(name))
    : all;
  const budgetMs = req.budget?.timeoutMs ?? 8000;

  const findings: BriefFindings = {};
  const analyzerStatus: Record<string, AnalyzerStatus> = {};
  let partial = false;

  await Promise.all(
    requested.map(async (name) => {
      try {
        const analyzer = analyzers[name];
        if (!analyzer) throw new Error("analyzer_unregistered");
        const result = await runWithTimeout(
          (signal) => analyzer(req, signal),
          budgetMs,
        );
        findings[name] = result as never;
        analyzerStatus[name] = "ok";
      } catch (error) {
        analyzerStatus[name] = "degraded";
        partial = true;
        captureAnalyzerDegradation(error, {
          analyzer: name,
          repoFullName: req.repoFullName,
          prNumber: req.prNumber,
          headSha: req.headSha,
          timeoutMs: budgetMs,
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
