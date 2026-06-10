import {
  getLatestUpstreamRulesetSnapshot,
  listLatestUpstreamRulesetSnapshots,
  listLatestUpstreamSourceSnapshotsByKey,
  listUpstreamDriftReports,
  persistUpstreamRulesetSnapshot,
  persistUpstreamSourceSnapshots,
  recordAuditEvent,
  updateUpstreamDriftReportIssue,
  upsertUpstreamDriftReport,
} from "../db/repositories";
import { normalizeRegistryPayload } from "../registry/normalize";
import { detectActiveModel, parsePythonNumberConstants } from "../scoring/model";
import type {
  JsonValue,
  RegistryDriftSurface,
  RegistryHyperparameterDriftEvent,
  RegistryHyperparameterDriftField,
  RegistryHyperparameterDriftSummary,
  RegistryRepoConfig,
  ScoringModelSnapshotRecord,
  UpstreamDriftArea,
  UpstreamDriftReportRecord,
  UpstreamDriftSeverity,
  UpstreamRulesetSnapshotRecord,
  UpstreamSourceSnapshotRecord,
} from "../types";
import { errorMessage, jsonString, nowIso } from "../utils/json";

const DEFAULT_UPSTREAM_REPO = "entrius/gittensor";
const DEFAULT_UPSTREAM_REF = "test";
const DEFAULT_DRIFT_ISSUE_REPO = "JSONbored/gittensory";
const UPSTREAM_STALE_MS = 2 * 60 * 60 * 1000;
const REGISTRY_HYPERPARAMETER_DRIFT_LIMIT = 100;

const TRACKED_SOURCES = [
  { key: "constants", path: "gittensor/constants.py" },
  { key: "registry", path: "gittensor/validator/weights/master_repositories.json" },
  { key: "programming_languages", path: "gittensor/validator/weights/programming_languages.json" },
  { key: "mirror_scoring", path: "gittensor/validator/oss_contributions/mirror/scoring.py" },
  { key: "issue_discovery_scan", path: "gittensor/validator/issue_discovery/scan.py" },
  { key: "mirror_models", path: "gittensor/utils/mirror/models.py" },
] as const;

type TrackedSource = (typeof TRACKED_SOURCES)[number];

type RulesetPayload = {
  upstream: { repo: string; ref: string; commitSha?: string | null | undefined };
  registry: {
    repoCount: number;
    totalEmissionShare: number;
    repositories: Array<{
      repo: string;
      emissionShare: number;
      issueDiscoveryShare: number;
      maintainerCut: number;
      labelMultipliers: Record<string, number>;
      trustedLabelPipeline: boolean | null;
      defaultLabelMultiplier: number | null;
      fixedBaseScore: number | null;
      eligibilityMode: string | null;
    }>;
  };
  scoring: {
    activeModel: ScoringModelSnapshotRecord["activeModel"];
    constants: Record<string, number>;
    semanticFlags: Record<string, boolean>;
  };
  issueDiscovery: {
    branchEligibilityRequired: boolean;
  };
  mirrorLinkage: {
    solvedByPrRequired: boolean;
  };
  languageWeights: {
    count: number;
    contentHash?: string | null | undefined;
    weights: Record<string, JsonValue>;
  };
  sourceSnapshots: Array<{ id: string; key: string; path: string; contentSha256?: string | null | undefined; status: string }>;
};

export type UpstreamStatus = {
  generatedAt: string;
  status: "current" | "drift_detected" | "stale" | "unavailable";
  latestCommitSha: string | null;
  latestRulesetId: string | null;
  latestRulesetGeneratedAt: string | null;
  activeModel: ScoringModelSnapshotRecord["activeModel"] | null;
  highestSeverity: UpstreamDriftSeverity | null;
  affectedAreas: UpstreamDriftArea[];
  registryHyperparameterDrift: RegistryHyperparameterDriftSummary;
  openReportCount: number;
  reports: Array<Record<string, JsonValue>>;
};

export async function refreshUpstreamSourceSnapshots(env: Env): Promise<UpstreamSourceSnapshotRecord[]> {
  const config = upstreamConfig(env);
  const fetchedAt = nowIso();
  const [previousByKey, commitSha] = await Promise.all([latestSourcesByKey(env), fetchUpstreamCommitSha(env, config)]);
  const snapshots = await Promise.all(
    TRACKED_SOURCES.map((source) => fetchTrackedSource(env, config, source, fetchedAt, commitSha, previousByKey.get(source.key))),
  );
  await persistUpstreamSourceSnapshots(env, snapshots);
  await recordAuditEvent(env, {
    eventType: "upstream.sources_refreshed",
    outcome: snapshots.some((snapshot) => snapshot.status === "error") ? "error" : "success",
    detail: config.ref,
    metadata: { sourceCount: snapshots.length, commitSha: commitSha ?? null },
  });
  return snapshots;
}

export async function buildUpstreamRulesetSnapshot(env: Env, sources?: UpstreamSourceSnapshotRecord[]): Promise<UpstreamRulesetSnapshotRecord> {
  const config = upstreamConfig(env);
  const latestSources = sources ?? (await listLatestUpstreamSourceSnapshotsByKey(env));
  const byKey = new Map(latestSources.map((source) => [source.sourceKey, source]));
  const warnings = latestSources.flatMap((source) => source.warnings.map((warning) => `${source.sourceKey}: ${warning}`));
  const constants = numericRecord(byKey.get("constants")?.parsed.constants);
  const activeModel = detectActiveModel(constants);
  const registry = registryPayload(byKey.get("registry")?.parsed.registry);
  const programmingLanguages = recordPayload(byKey.get("programming_languages")?.parsed.weights);
  const mirrorScoring = recordPayload(byKey.get("mirror_scoring")?.parsed);
  const issueDiscovery = recordPayload(byKey.get("issue_discovery_scan")?.parsed);
  const mirrorModels = recordPayload(byKey.get("mirror_models")?.parsed);
  const commitSha = firstValue(latestSources.map((source) => source.commitSha));
  const payload: RulesetPayload = {
    upstream: { repo: config.repo, ref: config.ref, commitSha },
    registry,
    scoring: {
      activeModel,
      constants,
      semanticFlags: {
        usesDensityModel: Boolean(mirrorScoring.usesDensityModel),
        usesSaturationModel: Boolean(mirrorScoring.usesSaturationModel || Number.isFinite(constants.SRC_TOK_SATURATION_SCALE)),
        usesExponentialSaturation: Boolean(mirrorScoring.usesExponentialSaturation || Number.isFinite(constants.SRC_TOK_SATURATION_SCALE)),
      },
    },
    issueDiscovery: {
      branchEligibilityRequired: Boolean(issueDiscovery.branchEligibilityRequired),
    },
    mirrorLinkage: {
      solvedByPrRequired: Boolean(mirrorScoring.solvedByPrRequired || mirrorModels.solvedByPrRequired),
    },
    languageWeights: {
      count: Object.keys(programmingLanguages).length,
      contentHash: byKey.get("programming_languages")?.contentSha256,
      weights: programmingLanguages,
    },
    sourceSnapshots: latestSources.map((source) => ({
      id: source.id,
      key: source.sourceKey,
      path: source.path,
      contentSha256: source.contentSha256,
      status: source.status,
    })),
  };
  const semanticHash = await sha256Hex(stableStringify(semanticPayload(payload)));
  const snapshot: UpstreamRulesetSnapshotRecord = {
    id: crypto.randomUUID(),
    sourceRepo: config.repo,
    sourceRef: config.ref,
    commitSha,
    sourceSnapshotIds: latestSources.map((source) => source.id),
    activeModel,
    registryRepoCount: registry.repoCount,
    totalEmissionShare: registry.totalEmissionShare,
    semanticHash,
    payload: payload as unknown as Record<string, JsonValue>,
    warnings,
    generatedAt: nowIso(),
  };
  await persistUpstreamRulesetSnapshot(env, snapshot);
  await recordAuditEvent(env, {
    eventType: "upstream.ruleset_built",
    outcome: warnings.length > 0 ? "completed" : "success",
    detail: activeModel,
    metadata: { rulesetId: snapshot.id, semanticHash, warningCount: warnings.length },
  });
  return snapshot;
}

export async function detectAndPersistUpstreamDrift(env: Env): Promise<{ current: UpstreamRulesetSnapshotRecord | null; previous: UpstreamRulesetSnapshotRecord | null; report: UpstreamDriftReportRecord | null }> {
  const [current, previous] = await listLatestUpstreamRulesetSnapshots(env, 2);
  const report = current ? await buildUpstreamDriftReport(current, previous ?? null) : null;
  if (report) await upsertUpstreamDriftReport(env, report);
  await recordAuditEvent(env, {
    eventType: "upstream.drift_detected",
    outcome: report ? "completed" : "success",
    detail: report?.severity ?? "none",
    metadata: { currentRulesetId: current?.id ?? null, previousRulesetId: previous?.id ?? null, fingerprint: report?.fingerprint ?? null },
  });
  return { current: current ?? null, previous: previous ?? null, report };
}

export async function refreshUpstreamDrift(env: Env): Promise<{ sources: UpstreamSourceSnapshotRecord[]; ruleset: UpstreamRulesetSnapshotRecord; drift: UpstreamDriftReportRecord | null }> {
  const sources = await refreshUpstreamSourceSnapshots(env);
  const ruleset = await buildUpstreamRulesetSnapshot(env, sources);
  const drift = await buildUpstreamDriftReport(ruleset, (await listLatestUpstreamRulesetSnapshots(env, 2))[1] ?? null);
  if (drift) await upsertUpstreamDriftReport(env, drift);
  await recordAuditEvent(env, {
    eventType: "upstream.drift_detected",
    outcome: drift ? "completed" : "success",
    detail: drift?.severity ?? "none",
    metadata: { currentRulesetId: ruleset.id, previousRulesetId: drift?.previousRulesetId ?? null, fingerprint: drift?.fingerprint ?? null },
  });
  return { sources, ruleset, drift };
}

export async function loadUpstreamStatus(env: Env): Promise<UpstreamStatus> {
  const [latestRuleset, reports] = await Promise.all([getLatestUpstreamRulesetSnapshot(env), listUpstreamDriftReports(env, 20)]);
  const openReports = reports.filter((report) => report.status === "open");
  const highest = highestSeverity(openReports.map((report) => report.severity));
  const registryHyperparameterDrift = summarizeRegistryHyperparameterDriftReports(openReports);
  const generatedAt = nowIso();
  const stale = latestRuleset ? Date.parse(latestRuleset.generatedAt) + UPSTREAM_STALE_MS < Date.now() : false;
  const affectedAreas = [...new Set(openReports.flatMap((report) => report.affectedAreas))].sort();
  return {
    generatedAt,
    status: latestRuleset ? (highest ? "drift_detected" : stale ? "stale" : "current") : "unavailable",
    latestCommitSha: latestRuleset?.commitSha ?? null,
    latestRulesetId: latestRuleset?.id ?? null,
    latestRulesetGeneratedAt: latestRuleset?.generatedAt ?? null,
    activeModel: latestRuleset?.activeModel ?? null,
    highestSeverity: highest ?? null,
    affectedAreas,
    registryHyperparameterDrift,
    openReportCount: openReports.length,
    reports: reports.map((report) => publicDriftReport(report)),
  };
}

export function registryHyperparameterDriftWarningsForRepo(reports: UpstreamDriftReportRecord[], repoFullName: string, limit = 3): string[] {
  const normalizedRepo = repoFullName.toLowerCase();
  const events = reports
    .filter((report) => report.status === "open")
    .flatMap((report) => readRegistryHyperparameterDriftPayload(report.payload.registryHyperparameterDrift).events)
    .filter((event) => event.repoFullName.toLowerCase() === normalizedRepo && (event.severity === "high" || event.severity === "blocking" || event.field === "maintainerCut"))
    .sort(compareRegistryHyperparameterDriftEvents);
  const shown = events.slice(0, limit);
  return [
    ...shown.map(
      (event) =>
        `Upstream registry drift is open for ${repoFullName}: ${registryHyperparameterFieldLabel(event.field)} changed; affected surface(s): ${event.affectedSurfaces.join(", ")}.`,
    ),
    ...(events.length > shown.length ? [`${events.length - shown.length} additional high-impact upstream registry drift event(s) are open for ${repoFullName}.`] : []),
  ];
}

export async function fileUpstreamDriftIssues(env: Env): Promise<Record<string, JsonValue>> {
  if (!truthy(env.GITTENSORY_AUTO_FILE_DRIFT_ISSUES)) {
    return { status: "disabled", created: 0, updated: 0, skipped: 0 };
  }
  const token = env.GITTENSORY_DRIFT_ISSUE_TOKEN ?? env.GITHUB_PUBLIC_TOKEN;
  if (!token) return { status: "skipped", reason: "missing_issue_token", created: 0, updated: 0, skipped: 0 };
  const repo = env.GITTENSORY_DRIFT_ISSUE_REPO || DEFAULT_DRIFT_ISSUE_REPO;
  const reports = (await listUpstreamDriftReports(env, 20)).filter((report) => report.status === "open");
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const report of reports) {
    const existing = (await validateRecordedGitHubIssue(repo, token, report)) ?? (await findGitHubIssueForFingerprint(repo, token, report.fingerprint));
    if (existing) {
      const issue = await updateGitHubDriftIssue(repo, token, existing.number, report);
      if (!issue) {
        skipped += 1;
        continue;
      }
      await updateUpstreamDriftReportIssue(env, report.fingerprint, issue);
      updated += 1;
      continue;
    }
    const issue = await createGitHubDriftIssue(repo, token, report);
    if (!issue) {
      skipped += 1;
      continue;
    }
    await updateUpstreamDriftReportIssue(env, report.fingerprint, issue);
    created += 1;
  }
  await recordAuditEvent(env, {
    eventType: "upstream.drift_issues_filed",
    outcome: "completed",
    metadata: { created, updated, skipped, repo },
  });
  return { status: "completed", created, updated, skipped };
}

export async function buildUpstreamDriftReport(current: UpstreamRulesetSnapshotRecord, previous: UpstreamRulesetSnapshotRecord | null): Promise<UpstreamDriftReportRecord | null> {
  if (!previous) return null;
  const currentPayload = rulesetPayload(current);
  const previousPayload = rulesetPayload(previous);
  if (current.semanticHash === previous.semanticHash) return null;

  const changes: string[] = [];
  const affected = new Set<UpstreamDriftArea>();
  let severity: UpstreamDriftSeverity = "low";

  const raise = (next: UpstreamDriftSeverity) => {
    severity = maxSeverity(severity, next);
  };
  if (current.activeModel !== previous.activeModel) {
    affected.add("scoring_model");
    raise(current.activeModel === "unknown" ? "blocking" : "high");
    changes.push(`active_model ${previous.activeModel} -> ${current.activeModel}`);
  }
  if (stableStringify(currentPayload.scoring.constants) !== stableStringify(previousPayload.scoring.constants)) {
    affected.add("scoring_model");
    raise("high");
    changes.push("scoring constants changed");
  }
  if (current.registryRepoCount !== previous.registryRepoCount || current.totalEmissionShare !== previous.totalEmissionShare) {
    affected.add("registry");
    raise("high");
    changes.push(`registry totals changed (${previous.registryRepoCount}/${previous.totalEmissionShare} -> ${current.registryRepoCount}/${current.totalEmissionShare})`);
  }
  const registryHyperparameterDrift = buildRegistryHyperparameterDrift(previousPayload.registry.repositories, currentPayload.registry.repositories);
  const repoChanges = changedRegistryRepos(registryHyperparameterDrift.events);
  if (registryHyperparameterDrift.totalEvents > 0) {
    affected.add("registry");
    raise(registryHyperparameterDrift.events[0]!.severity);
    changes.push(`${registryHyperparameterDrift.totalEvents} registry hyperparameter drift event(s)`);
  }
  if (currentPayload.issueDiscovery.branchEligibilityRequired !== previousPayload.issueDiscovery.branchEligibilityRequired) {
    affected.add("issue_discovery");
    raise("high");
    changes.push(`branch eligibility ${previousPayload.issueDiscovery.branchEligibilityRequired} -> ${currentPayload.issueDiscovery.branchEligibilityRequired}`);
  }
  if (currentPayload.mirrorLinkage.solvedByPrRequired !== previousPayload.mirrorLinkage.solvedByPrRequired) {
    affected.add("mirror_linkage");
    raise("high");
    changes.push(`solved_by_pr requirement ${previousPayload.mirrorLinkage.solvedByPrRequired} -> ${currentPayload.mirrorLinkage.solvedByPrRequired}`);
  }
  if (currentPayload.languageWeights.contentHash !== previousPayload.languageWeights.contentHash) {
    affected.add("language_weights");
    raise("medium");
    changes.push("programming language weights changed");
  }
  if (affected.size === 0) affected.add("source");
  const affectedAreas = [...affected].sort();
  const fingerprint = await sha256Hex(stableStringify({ current: current.semanticHash, previous: previous.semanticHash, affectedAreas }));
  const now = nowIso();
  const source = {
    repo: current.sourceRepo,
    ref: current.sourceRef,
    commitSha: current.commitSha ?? null,
  };
  const recommendedFollowUp = upstreamRecommendedFollowUpForAreas(affectedAreas);
  return {
    id: crypto.randomUUID(),
    fingerprint,
    severity,
    status: "open",
    summary: changes.length > 0 ? changes.join("; ") : "Upstream source content changed without parsed semantic drift.",
    affectedAreas,
    previousRulesetId: previous.id,
    currentRulesetId: current.id,
    payload: {
      changes,
      repoChanges,
      registryHyperparameterDrift,
      source,
      recommendedFollowUp,
      current: publicRuleset(current),
      previous: publicRuleset(previous),
    },
    generatedAt: now,
    updatedAt: now,
  };
}

function upstreamConfig(env: Env): { repo: string; ref: string } {
  return {
    repo: env.GITTENSOR_UPSTREAM_REPO || DEFAULT_UPSTREAM_REPO,
    ref: env.GITTENSOR_UPSTREAM_REF || DEFAULT_UPSTREAM_REF,
  };
}

async function latestSourcesByKey(env: Env): Promise<Map<string, UpstreamSourceSnapshotRecord>> {
  return new Map((await listLatestUpstreamSourceSnapshotsByKey(env)).map((source) => [source.sourceKey, source]));
}

async function fetchUpstreamCommitSha(env: Env, config: { repo: string; ref: string }): Promise<string | null> {
  const url = `https://api.github.com/repos/${config.repo}/commits/${encodeURIComponent(config.ref)}`;
  try {
    const response = await fetch(url, { headers: githubHeaders(env.GITHUB_PUBLIC_TOKEN, "application/vnd.github+json") });
    if (!response.ok) return null;
    const payload = (await response.json()) as { sha?: string };
    return payload.sha ?? null;
  } catch {
    return null;
  }
}

async function fetchTrackedSource(
  env: Env,
  config: { repo: string; ref: string },
  source: TrackedSource,
  fetchedAt: string,
  commitSha: string | null,
  previous?: UpstreamSourceSnapshotRecord,
): Promise<UpstreamSourceSnapshotRecord> {
  const apiUrl = `https://api.github.com/repos/${config.repo}/contents/${source.path}?ref=${encodeURIComponent(config.ref)}`;
  const warnings: string[] = [];
  try {
    const response = await fetch(apiUrl, {
      headers: {
        ...githubHeaders(env.GITHUB_PUBLIC_TOKEN, "application/vnd.github+json"),
        ...(previous?.etag ? { "if-none-match": previous.etag } : {}),
      },
    });
    if (response.status === 304 && previous) return cloneNotModifiedSnapshot(previous, fetchedAt, commitSha);
    if (response.ok) {
      const payload = (await response.json()) as { content?: string; encoding?: string; sha?: string; download_url?: string | null };
      const content = payload.encoding === "base64" && payload.content ? decodeBase64(payload.content) : "";
      if (!content) throw new Error("GitHub contents response did not include file content.");
      return sourceSnapshotFromContent({
        config,
        source,
        sourceUrl: payload.download_url ?? rawUrl(config, source.path),
        commitSha,
        blobSha: payload.sha,
        etag: response.headers.get("etag"),
        content,
        fetchedAt,
        status: "fetched",
        warnings,
      });
    }
    warnings.push(`GitHub contents API failed (${response.status}); raw fallback used.`);
  } catch (error) {
    warnings.push(`GitHub contents API failed (${errorMessage(error)}); raw fallback used.`);
  }

  try {
    const response = await fetch(rawUrl(config, source.path), { headers: githubHeaders(env.GITHUB_PUBLIC_TOKEN, "text/plain") });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return sourceSnapshotFromContent({
      config,
      source,
      sourceUrl: rawUrl(config, source.path),
      commitSha,
      content: await response.text(),
      fetchedAt,
      status: "fallback",
      warnings,
    });
  } catch (error) {
    return {
      id: crypto.randomUUID(),
      sourceKey: source.key,
      sourceRepo: config.repo,
      sourceRef: config.ref,
      path: source.path,
      sourceUrl: rawUrl(config, source.path),
      commitSha,
      status: "error",
      parsed: previous?.parsed ?? {},
      warnings: [...warnings, `Raw fallback failed: ${errorMessage(error)}`],
      payload: { previousSnapshotId: previous?.id ?? null },
      fetchedAt,
    };
  }
}

async function sourceSnapshotFromContent(args: {
  config: { repo: string; ref: string };
  source: TrackedSource;
  sourceUrl: string;
  commitSha: string | null;
  blobSha?: string | undefined;
  etag?: string | null | undefined;
  content: string;
  fetchedAt: string;
  status: "fetched" | "fallback";
  warnings: string[];
}): Promise<UpstreamSourceSnapshotRecord> {
  const contentSha256 = await sha256Hex(args.content);
  return {
    id: crypto.randomUUID(),
    sourceKey: args.source.key,
    sourceRepo: args.config.repo,
    sourceRef: args.config.ref,
    path: args.source.path,
    sourceUrl: args.sourceUrl,
    commitSha: args.commitSha,
    blobSha: args.blobSha,
    contentSha256,
    etag: args.etag,
    status: args.status,
    parsed: parseTrackedSource(args.source, args.content, args.sourceUrl, args.fetchedAt),
    warnings: args.warnings,
    payload: { sourceBytes: args.content.length },
    fetchedAt: args.fetchedAt,
  };
}

function cloneNotModifiedSnapshot(previous: UpstreamSourceSnapshotRecord, fetchedAt: string, commitSha: string | null): UpstreamSourceSnapshotRecord {
  return {
    ...previous,
    id: crypto.randomUUID(),
    commitSha: commitSha ?? previous.commitSha,
    status: "not_modified",
    payload: { ...previous.payload, previousSnapshotId: previous.id },
    fetchedAt,
  };
}

function parseTrackedSource(source: TrackedSource, content: string, sourceUrl: string, fetchedAt: string): Record<string, JsonValue> {
  if (source.key === "constants") {
    const constants = parsePythonNumberConstants(content, { knownOnly: false });
    return {
      constants,
      knownConstants: parsePythonNumberConstants(content),
      activeModel: detectActiveModel(constants),
    };
  }
  if (source.key === "registry") {
    const payload = safeJson(content);
    const snapshot = normalizeRegistryPayload(payload, { kind: "raw-github", url: sourceUrl }, fetchedAt);
    return {
      registry: {
        repoCount: snapshot.repoCount,
        totalEmissionShare: snapshot.totalEmissionShare,
        repositories: snapshot.repositories.map(compactRegistryRepo),
      },
    };
  }
  if (source.key === "programming_languages") {
    const weights = recordPayload(safeJson(content));
    return { weights, count: Object.keys(weights).length };
  }
  if (source.key === "mirror_scoring") {
    return {
      usesDensityModel: /density|MAX_CODE_DENSITY_MULTIPLIER|CODE_DENSITY/i.test(content),
      usesSaturationModel: /saturation|SRC_TOK_SATURATION_SCALE/i.test(content),
      usesExponentialSaturation: /exp\(|exponential|math\.exp|1\s*-\s*e\s*\*\*/i.test(content),
      solvedByPrRequired: /solved_by_pr/i.test(content),
    };
  }
  if (source.key === "issue_discovery_scan") {
    return {
      branchEligibilityRequired: /branch.{0,80}eligib|eligib.{0,80}branch|solving.{0,80}branch/i.test(content),
    };
  }
  if (source.key === "mirror_models") {
    return {
      solvedByPrRequired: /solved_by_pr/i.test(content),
    };
  }
  /* v8 ignore next -- TRACKED_SOURCES is exhaustive; keep a defensive fallback for future source additions. */
  return {};
}

function compactRegistryRepo(repo: RegistryRepoConfig): RulesetPayload["registry"]["repositories"][number] {
  return {
    repo: repo.repo,
    emissionShare: repo.emissionShare,
    issueDiscoveryShare: repo.issueDiscoveryShare,
    maintainerCut: repo.maintainerCut,
    labelMultipliers: repo.labelMultipliers,
    trustedLabelPipeline: repo.trustedLabelPipeline ?? null,
    defaultLabelMultiplier: repo.defaultLabelMultiplier ?? null,
    fixedBaseScore: repo.fixedBaseScore ?? null,
    eligibilityMode: repo.eligibilityMode ?? null,
  };
}

function registryPayload(value: JsonValue | undefined, fallback: Pick<RulesetPayload["registry"], "repoCount" | "totalEmissionShare"> = { repoCount: 0, totalEmissionShare: 0 }): RulesetPayload["registry"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback, repositories: [] };
  const payload = value as { repoCount?: JsonValue; totalEmissionShare?: JsonValue; repositories?: JsonValue };
  return {
    repoCount: numberPayload(payload.repoCount) ?? fallback.repoCount,
    totalEmissionShare: numberPayload(payload.totalEmissionShare) ?? fallback.totalEmissionShare,
    repositories: Array.isArray(payload.repositories) ? normalizeRulesetRegistryRepos(payload.repositories) : [],
  };
}

function rulesetPayload(snapshot: UpstreamRulesetSnapshotRecord): RulesetPayload {
  const payload = snapshot.payload as unknown as Partial<RulesetPayload>;
  return {
    upstream: payload.upstream ?? { repo: snapshot.sourceRepo, ref: snapshot.sourceRef, commitSha: snapshot.commitSha },
    registry: registryPayload(payload.registry as unknown as JsonValue | undefined, { repoCount: snapshot.registryRepoCount, totalEmissionShare: snapshot.totalEmissionShare }),
    scoring: payload.scoring ?? { activeModel: snapshot.activeModel, constants: {}, semanticFlags: {} },
    issueDiscovery: payload.issueDiscovery ?? { branchEligibilityRequired: false },
    mirrorLinkage: payload.mirrorLinkage ?? { solvedByPrRequired: false },
    languageWeights: payload.languageWeights ?? { count: 0, weights: {} },
    sourceSnapshots: payload.sourceSnapshots ?? [],
  };
}

function semanticPayload(payload: RulesetPayload): Record<string, JsonValue> {
  return {
    registry: payload.registry,
    scoring: payload.scoring,
    issueDiscovery: payload.issueDiscovery,
    mirrorLinkage: payload.mirrorLinkage,
    languageWeights: {
      count: payload.languageWeights.count,
      contentHash: payload.languageWeights.contentHash ?? null,
    },
  };
}

type RulesetRegistryRepo = RulesetPayload["registry"]["repositories"][number];
// `affectedRepos` is the pre-cap list of distinct affected repositories, kept on the stored payload
// (not the public summary) so multi-report aggregation can union repos across reports instead of
// summing per-report counts. Mirrors how `affectedFields`/`affectedSurfaces` are unioned.
type RegistryHyperparameterDriftPayload = RegistryHyperparameterDriftSummary & {
  events: RegistryHyperparameterDriftEvent[];
  affectedRepos: string[];
  unidentifiedAffectedRepoCount: number;
};

function uniqueRepoNames(events: RegistryHyperparameterDriftEvent[]): string[] {
  return [...new Set(events.map((event) => event.repoFullName))].sort((left, right) => left.localeCompare(right));
}

const REGISTRY_DRIFT_FIELD_ORDER: RegistryHyperparameterDriftField[] = [
  "repo",
  "emissionShare",
  "issueDiscoveryShare",
  "maintainerCut",
  "fixedBaseScore",
  "eligibilityMode",
  "trustedLabelPipeline",
  "defaultLabelMultiplier",
  "labelMultipliers",
];
type RegistryComparableHyperparameterField = Exclude<RegistryHyperparameterDriftField, "repo">;
const REGISTRY_DRIFT_COMPARABLE_FIELDS: RegistryComparableHyperparameterField[] = [
  "emissionShare",
  "issueDiscoveryShare",
  "maintainerCut",
  "fixedBaseScore",
  "eligibilityMode",
  "trustedLabelPipeline",
  "defaultLabelMultiplier",
  "labelMultipliers",
];

const REGISTRY_DRIFT_FIELD_METADATA: Record<RegistryHyperparameterDriftField, { severity: UpstreamDriftSeverity; affectedSurfaces: RegistryDriftSurface[] }> = {
  repo: { severity: "high", affectedSurfaces: ["allocation", "lane_fit"] },
  emissionShare: { severity: "high", affectedSurfaces: ["allocation", "lane_fit"] },
  issueDiscoveryShare: { severity: "high", affectedSurfaces: ["issue_discovery_behavior", "lane_fit"] },
  maintainerCut: { severity: "high", affectedSurfaces: ["maintainer_economics"] },
  fixedBaseScore: { severity: "high", affectedSurfaces: ["scoreability_assumptions"] },
  eligibilityMode: { severity: "high", affectedSurfaces: ["lane_fit", "scoreability_assumptions"] },
  trustedLabelPipeline: { severity: "medium", affectedSurfaces: ["label_policy", "scoreability_assumptions"] },
  defaultLabelMultiplier: { severity: "medium", affectedSurfaces: ["label_policy", "scoreability_assumptions"] },
  labelMultipliers: { severity: "medium", affectedSurfaces: ["label_policy", "scoreability_assumptions"] },
};

function buildRegistryHyperparameterDrift(previous: RulesetRegistryRepo[], current: RulesetRegistryRepo[]): RegistryHyperparameterDriftPayload {
  const previousByRepo = new Map(previous.map((repo) => [repo.repo, repo]));
  const currentByRepo = new Map(current.map((repo) => [repo.repo, repo]));
  const events = [
    ...current.flatMap((repo) => {
      const old = previousByRepo.get(repo.repo);
      return old ? changedRegistryRepoEvents(old, repo) : [registryHyperparameterDriftEvent(repo.repo, "repo", null, "added", "added")];
    }),
    ...previous.flatMap((repo) => (currentByRepo.has(repo.repo) ? [] : [registryHyperparameterDriftEvent(repo.repo, "repo", "present", null, "removed")])),
  ].sort(compareRegistryHyperparameterDriftEvents);
  const capped = events.slice(0, REGISTRY_HYPERPARAMETER_DRIFT_LIMIT);
  return {
    ...summarizeRegistryHyperparameterDriftEvents(events),
    events: capped,
    affectedRepos: uniqueRepoNames(events),
    unidentifiedAffectedRepoCount: 0,
    omittedEvents: Math.max(events.length - capped.length, 0),
  };
}

function changedRegistryRepoEvents(previous: RulesetRegistryRepo, current: RulesetRegistryRepo): RegistryHyperparameterDriftEvent[] {
  return REGISTRY_DRIFT_COMPARABLE_FIELDS.flatMap((field) => {
    const oldValue = registryHyperparameterValue(previous, field);
    const newValue = registryHyperparameterValue(current, field);
    if (stableStringify(oldValue) === stableStringify(newValue)) return [];
    return [registryHyperparameterDriftEvent(current.repo, field, oldValue, newValue, registryHyperparameterChangeSummary(field, oldValue, newValue))];
  });
}

function registryHyperparameterDriftEvent(repoFullName: string, field: RegistryHyperparameterDriftField, previous: JsonValue, current: JsonValue, summary: string): RegistryHyperparameterDriftEvent {
  const metadata = REGISTRY_DRIFT_FIELD_METADATA[field];
  return {
    repoFullName,
    field,
    previous,
    current,
    severity: metadata.severity,
    affectedSurfaces: metadata.affectedSurfaces,
    summary,
  };
}

function changedRegistryRepos(events: RegistryHyperparameterDriftEvent[]): string[] {
  const byRepo = new Map<string, RegistryHyperparameterDriftEvent[]>();
  for (const event of events) byRepo.set(event.repoFullName, [...(byRepo.get(event.repoFullName) ?? []), event]);
  return [...byRepo.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repo, repoEvents]) => `${repo}: ${repoEvents.sort(compareRegistryHyperparameterDriftEvents).map((event) => event.summary).join(", ")}`);
}

function summarizeRegistryHyperparameterDriftEvents(events: RegistryHyperparameterDriftEvent[]): RegistryHyperparameterDriftSummary {
  return {
    totalEvents: events.length,
    omittedEvents: 0,
    highImpactCount: events.filter((event) => event.severity === "high" || event.severity === "blocking").length,
    affectedRepoCount: new Set(events.map((event) => event.repoFullName)).size,
    affectedFields: uniqueSorted(events.map((event) => event.field), REGISTRY_DRIFT_FIELD_ORDER),
    affectedSurfaces: uniqueSorted(
      events.flatMap((event) => event.affectedSurfaces),
      ["allocation", "lane_fit", "scoreability_assumptions", "maintainer_economics", "issue_discovery_behavior", "label_policy"],
    ),
  };
}

function summarizeRegistryHyperparameterDriftReports(reports: UpstreamDriftReportRecord[]): RegistryHyperparameterDriftSummary {
  const payloads = reports.map((report) => readRegistryHyperparameterDriftPayload(report.payload.registryHyperparameterDrift));
  const events = payloads.flatMap((payload) => payload.events);
  const fallbackSummary = summarizeRegistryHyperparameterDriftEvents(events);
  const affectedRepoNames = new Set(payloads.flatMap((payload) => payload.affectedRepos));
  const unidentifiedAffectedRepoCount = sum(payloads.map((payload) => payload.unidentifiedAffectedRepoCount));
  return {
    totalEvents: sum(payloads.map((payload) => payload.totalEvents)) || fallbackSummary.totalEvents,
    omittedEvents: sum(payloads.map((payload) => payload.omittedEvents)),
    highImpactCount: sum(payloads.map((payload) => payload.highImpactCount)) || fallbackSummary.highImpactCount,
    // Distinct repos across reports, not the sum of per-report unique counts -- a repo affected in
    // several open reports must be counted once. Union the pre-cap repo lists (same approach as
    // affectedFields/affectedSurfaces below). Legacy capped reports may only identify the first
    // affected repos in `events`, so add any stored count above the identifiable repo list as
    // unidentified repos to avoid underreporting their scale.
    affectedRepoCount: affectedRepoNames.size + unidentifiedAffectedRepoCount || fallbackSummary.affectedRepoCount,
    affectedFields: uniqueSorted(payloads.flatMap((payload) => payload.affectedFields), REGISTRY_DRIFT_FIELD_ORDER),
    affectedSurfaces: uniqueSorted(
      payloads.flatMap((payload) => payload.affectedSurfaces),
      ["allocation", "lane_fit", "scoreability_assumptions", "maintainer_economics", "issue_discovery_behavior", "label_policy"],
    ),
  };
}

function readRegistryHyperparameterDriftPayload(value: JsonValue | undefined): RegistryHyperparameterDriftPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyRegistryHyperparameterDriftPayload();
  const payload = value as Record<string, JsonValue>;
  const events = Array.isArray(payload.events) ? payload.events.flatMap(readRegistryHyperparameterDriftEvent) : [];
  const fallback = summarizeRegistryHyperparameterDriftEvents(events);
  const affectedFields = arrayPayload(payload.affectedFields).flatMap(readRegistryHyperparameterDriftField);
  const affectedSurfaces = arrayPayload(payload.affectedSurfaces).flatMap(readRegistryDriftSurface);
  const affectedRepos = arrayPayload(payload.affectedRepos).filter((entry): entry is string => typeof entry === "string");
  const derivedAffectedRepos = affectedRepos.length > 0 ? affectedRepos : uniqueRepoNames(events);
  const affectedRepoCount = numberPayload(payload.affectedRepoCount) ?? fallback.affectedRepoCount;
  return {
    events,
    totalEvents: numberPayload(payload.totalEvents) ?? fallback.totalEvents,
    omittedEvents: numberPayload(payload.omittedEvents) ?? fallback.omittedEvents,
    highImpactCount: numberPayload(payload.highImpactCount) ?? fallback.highImpactCount,
    affectedRepoCount,
    affectedFields: affectedFields.length > 0 ? affectedFields : fallback.affectedFields,
    affectedSurfaces: affectedSurfaces.length > 0 ? affectedSurfaces : fallback.affectedSurfaces,
    // Legacy payloads predate `affectedRepos`; derive it from the stored (capped) events so the
    // reports aggregator can still union repos rather than fall back to summing.
    affectedRepos: derivedAffectedRepos,
    unidentifiedAffectedRepoCount: derivedAffectedRepos.length > 0 ? Math.max(affectedRepoCount - derivedAffectedRepos.length, 0) : 0,
  };
}

function readRegistryHyperparameterDriftEvent(value: JsonValue): RegistryHyperparameterDriftEvent[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const payload = value as Record<string, JsonValue>;
  const repoFullName = typeof payload.repoFullName === "string" ? payload.repoFullName : null;
  const field = readRegistryHyperparameterDriftField(payload.field)[0];
  const severity = readUpstreamDriftSeverity(payload.severity);
  if (!repoFullName || !field || !severity) return [];
  return [
    {
      repoFullName,
      field,
      previous: payload.previous ?? null,
      current: payload.current ?? null,
      severity,
      affectedSurfaces: arrayPayload(payload.affectedSurfaces).flatMap(readRegistryDriftSurface),
      summary: typeof payload.summary === "string" ? payload.summary : registryHyperparameterChangeSummary(field, payload.previous ?? null, payload.current ?? null),
    },
  ];
}

function emptyRegistryHyperparameterDriftPayload(): RegistryHyperparameterDriftPayload {
  return {
    events: [],
    totalEvents: 0,
    omittedEvents: 0,
    highImpactCount: 0,
    affectedRepoCount: 0,
    affectedFields: [],
    affectedSurfaces: [],
    affectedRepos: [],
    unidentifiedAffectedRepoCount: 0,
  };
}

function normalizeRulesetRegistryRepos(value: JsonValue[]): RulesetRegistryRepo[] {
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const repo = entry as Record<string, JsonValue>;
    return typeof repo.repo === "string"
      ? [
          {
            repo: repo.repo,
            emissionShare: numberPayload(repo.emissionShare) ?? 0,
            issueDiscoveryShare: numberPayload(repo.issueDiscoveryShare) ?? 0,
            maintainerCut: numberPayload(repo.maintainerCut) ?? 0,
            labelMultipliers: numericRecord(repo.labelMultipliers),
            trustedLabelPipeline: booleanPayload(repo.trustedLabelPipeline),
            defaultLabelMultiplier: numberPayload(repo.defaultLabelMultiplier),
            fixedBaseScore: numberPayload(repo.fixedBaseScore),
            eligibilityMode: stringPayload(repo.eligibilityMode),
          },
        ]
      : [];
  });
}

function registryHyperparameterValue(repo: RulesetRegistryRepo, field: RegistryComparableHyperparameterField): JsonValue {
  switch (field) {
    case "emissionShare":
      return repo.emissionShare;
    case "issueDiscoveryShare":
      return repo.issueDiscoveryShare;
    case "maintainerCut":
      return repo.maintainerCut;
    case "labelMultipliers":
      return repo.labelMultipliers;
    case "trustedLabelPipeline":
      return repo.trustedLabelPipeline;
    case "defaultLabelMultiplier":
      return repo.defaultLabelMultiplier;
    case "fixedBaseScore":
      return repo.fixedBaseScore;
    case "eligibilityMode":
      return repo.eligibilityMode;
  }
}

function registryHyperparameterChangeSummary(field: RegistryHyperparameterDriftField, previous: JsonValue, current: JsonValue): string {
  if (field === "labelMultipliers") return "labelMultipliers changed";
  return `${field} ${formatRegistryHyperparameterValue(previous)} -> ${formatRegistryHyperparameterValue(current)}`;
}

function registryHyperparameterFieldLabel(field: RegistryHyperparameterDriftField): string {
  return {
    repo: "repository membership",
    emissionShare: "allocation",
    issueDiscoveryShare: "issue-discovery share",
    maintainerCut: "maintainer cut",
    labelMultipliers: "label multipliers",
    trustedLabelPipeline: "trusted-label flag",
    defaultLabelMultiplier: "default label multiplier",
    fixedBaseScore: "fixed base score",
    eligibilityMode: "eligibility mode",
  }[field];
}

function formatRegistryHyperparameterValue(value: JsonValue): string {
  if (value === null) return "unset";
  if (typeof value === "object") return "changed";
  return String(value);
}

function compareRegistryHyperparameterDriftEvents(left: RegistryHyperparameterDriftEvent, right: RegistryHyperparameterDriftEvent): number {
  return (
    severityRank(right.severity) - severityRank(left.severity) ||
    left.repoFullName.localeCompare(right.repoFullName) ||
    REGISTRY_DRIFT_FIELD_ORDER.indexOf(left.field) - REGISTRY_DRIFT_FIELD_ORDER.indexOf(right.field)
  );
}

function uniqueSorted<T extends string>(values: T[], order: readonly T[]): T[] {
  const unique = [...new Set(values)];
  return unique.sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

function readRegistryHyperparameterDriftField(value: JsonValue | undefined): RegistryHyperparameterDriftField[] {
  return typeof value === "string" && REGISTRY_DRIFT_FIELD_ORDER.includes(value as RegistryHyperparameterDriftField) ? [value as RegistryHyperparameterDriftField] : [];
}

function readRegistryDriftSurface(value: JsonValue | undefined): RegistryDriftSurface[] {
  const surfaces: RegistryDriftSurface[] = ["allocation", "lane_fit", "scoreability_assumptions", "maintainer_economics", "issue_discovery_behavior", "label_policy"];
  return typeof value === "string" && surfaces.includes(value as RegistryDriftSurface) ? [value as RegistryDriftSurface] : [];
}

function readUpstreamDriftSeverity(value: JsonValue | undefined): UpstreamDriftSeverity | null {
  return typeof value === "string" && ["low", "medium", "high", "blocking"].includes(value) ? (value as UpstreamDriftSeverity) : null;
}

function numberPayload(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringPayload(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function booleanPayload(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function arrayPayload(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function publicRuleset(snapshot: UpstreamRulesetSnapshotRecord): Record<string, JsonValue> {
  return {
    id: snapshot.id,
    commitSha: snapshot.commitSha ?? null,
    activeModel: snapshot.activeModel,
    registryRepoCount: snapshot.registryRepoCount,
    totalEmissionShare: snapshot.totalEmissionShare,
    semanticHash: snapshot.semanticHash,
    generatedAt: snapshot.generatedAt,
  };
}

function publicDriftReport(report: UpstreamDriftReportRecord): Record<string, JsonValue> {
  const source = recordPayload(report.payload.source);
  const recommendedFollowUp = arrayPayload(report.payload.recommendedFollowUp).filter((entry): entry is string => typeof entry === "string");
  return {
    id: report.id,
    fingerprint: report.fingerprint,
    severity: report.severity,
    status: report.status,
    summary: report.summary,
    affectedAreas: report.affectedAreas,
    source: {
      repo: stringPayload(source.repo) ?? null,
      ref: stringPayload(source.ref) ?? null,
      commitSha: stringPayload(source.commitSha),
    },
    recommendedFollowUp,
    previousRulesetId: report.previousRulesetId ?? null,
    currentRulesetId: report.currentRulesetId ?? null,
    issueNumber: report.issueNumber ?? null,
    issueUrl: report.issueUrl ?? null,
    generatedAt: report.generatedAt,
    updatedAt: report.updatedAt,
  };
}

async function findGitHubIssueForFingerprint(repo: string, token: string, fingerprint: string): Promise<{ number: number; url: string } | null> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  const url = `https://api.github.com/repos/${owner}/${name}/issues?state=open&labels=signals&per_page=50`;
  try {
    const response = await fetch(url, { headers: githubHeaders(token, "application/vnd.github+json") });
    if (!response.ok) return null;
    const issues = (await response.json()) as Array<{ number?: number; html_url?: string; body?: string | null }>;
    const match = issues.find((issue) => issue.body?.includes(`gittensory-upstream-drift:${fingerprint}`));
    return match?.number && match.html_url ? { number: match.number, url: match.html_url } : null;
  } catch {
    return null;
  }
}

async function createGitHubDriftIssue(repo: string, token: string, report: UpstreamDriftReportRecord): Promise<{ number: number; url: string } | null> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
    method: "POST",
    headers: githubHeaders(token, "application/vnd.github+json"),
    body: jsonString(githubDriftIssuePayload(report)),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { number?: number; html_url?: string };
  return payload.number && payload.html_url ? { number: payload.number, url: payload.html_url } : null;
}

async function updateGitHubDriftIssue(repo: string, token: string, issueNumber: number, report: UpstreamDriftReportRecord): Promise<{ number: number; url: string } | null> {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: githubHeaders(token, "application/vnd.github+json"),
    body: jsonString(githubDriftIssuePayload(report)),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { number?: number; html_url?: string };
  return payload.number && payload.html_url ? { number: payload.number, url: payload.html_url } : null;
}

async function validateRecordedGitHubIssue(repo: string, token: string, report: UpstreamDriftReportRecord): Promise<{ number: number; url: string } | null> {
  if (!Number.isInteger(report.issueNumber) || !report.issueNumber || report.issueNumber <= 0 || !report.issueUrl) return null;
  const parsedUrl = parseGitHubIssueUrl(report.issueUrl);
  const [owner, name] = repo.split("/");
  if (!owner || !name || !parsedUrl || parsedUrl.number !== report.issueNumber) return null;
  if (parsedUrl.owner.toLowerCase() !== owner.toLowerCase() || parsedUrl.name.toLowerCase() !== name.toLowerCase()) return null;
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${report.issueNumber}`, { headers: githubHeaders(token, "application/vnd.github+json") });
    if (!response.ok) return null;
    const issue = (await response.json()) as { number?: number; html_url?: string; state?: string; body?: string | null; labels?: Array<string | { name?: string }> };
    if (issue.number !== report.issueNumber || !issue.html_url || issue.state !== "open") return null;
    if (!issue.body?.includes(`gittensory-upstream-drift:${report.fingerprint}`)) return null;
    if (!issue.labels?.some((label) => (typeof label === "string" ? label : label.name) === "signals")) return null;
    const issueUrl = parseGitHubIssueUrl(issue.html_url);
    if (!issueUrl || issueUrl.number !== report.issueNumber) return null;
    if (issueUrl.owner.toLowerCase() !== owner.toLowerCase() || issueUrl.name.toLowerCase() !== name.toLowerCase()) return null;
    return { number: report.issueNumber, url: issue.html_url };
  } catch {
    return null;
  }
}

function parseGitHubIssueUrl(issueUrl: string): { owner: string; name: string; number: number } | null {
  try {
    const url = new URL(issueUrl);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const [owner, name, issues, issueNumber, ...rest] = url.pathname.split("/").filter(Boolean);
    const number = Number(issueNumber);
    if (!owner || !name || issues !== "issues" || rest.length > 0 || !Number.isInteger(number) || number <= 0) return null;
    return { owner, name, number };
  } catch {
    return null;
  }
}

function githubDriftIssueTitle(report: UpstreamDriftReportRecord): string {
  return `chore(upstream): reconcile Gittensor drift ${report.fingerprint.slice(0, 8)}`;
}

function githubDriftIssuePayload(report: UpstreamDriftReportRecord): Record<string, JsonValue> {
  return {
    title: githubDriftIssueTitle(report),
    body: githubDriftIssueBody(report),
    labels: ["signals", "scoring", "data", report.severity === "high" || report.severity === "blocking" ? "high-impact" : "backend"],
    assignees: ["jsonbored"],
  };
}

function githubDriftIssueBody(report: UpstreamDriftReportRecord): string {
  return [
    `<!-- gittensory-upstream-drift:${report.fingerprint} -->`,
    "",
    "## Background",
    "",
    "Gittensory detected upstream Gittensor rule drift that may require code or fixture updates.",
    "",
    "## Drift Summary",
    "",
    `- Severity: ${report.severity}`,
    `- Changed upstream source: ${changedUpstreamSourceSummary(report.affectedAreas)}`,
    `- Affected areas: ${report.affectedAreas.join(", ") || "source"}`,
    `- Summary: ${report.summary}`,
    `- Current ruleset: ${report.currentRulesetId ?? "unknown"}`,
    `- Previous ruleset: ${report.previousRulesetId ?? "unknown"}`,
    "",
    "## Suggested Tests",
    "",
    "- Add or update regression fixtures for the affected upstream source paths.",
    "- Run `npx vitest run test/unit/upstream-ruleset.test.ts`.",
    "- Run `npm run test:ci` and keep coverage at or above 97%.",
    "",
    "## Required Follow-Up",
    "",
    "- Inspect the upstream ruleset drift report in the private API.",
    "- Update Gittensory parsing/scoring fixtures if the semantic change is expected.",
    "- Keep public GitHub output sanitized and avoid private contributor context.",
  ].join("\n");
}

function changedUpstreamSourceSummary(affectedAreas: UpstreamDriftArea[]): string {
  const paths = new Set<string>();
  for (const area of affectedAreas.length > 0 ? affectedAreas : (["source"] as UpstreamDriftArea[])) {
    for (const path of upstreamSourcePathsForArea(area)) paths.add(path);
  }
  return [...paths].join(", ");
}

function upstreamSourcePathsForArea(area: UpstreamDriftArea): string[] {
  switch (area) {
    case "registry":
      return ["gittensor/validator/weights/master_repositories.json"];
    case "scoring_model":
      return ["gittensor/constants.py", "gittensor/validator/oss_contributions/mirror/scoring.py"];
    case "issue_discovery":
      return ["gittensor/validator/issue_discovery/scan.py"];
    case "mirror_linkage":
      return ["gittensor/validator/oss_contributions/mirror/scoring.py", "gittensor/utils/mirror/models.py"];
    case "language_weights":
      return ["gittensor/validator/weights/programming_languages.json"];
    case "source":
      return TRACKED_SOURCES.map((source) => source.path);
  }
}

function upstreamRecommendedFollowUpForAreas(areas: UpstreamDriftArea[]): string[] {
  const modules = new Set<string>();
  for (const area of areas.length > 0 ? areas : (["source"] as UpstreamDriftArea[])) {
    for (const module of upstreamModulesForArea(area)) modules.add(module);
  }
  return [...modules].sort();
}

function upstreamModulesForArea(area: UpstreamDriftArea): string[] {
  switch (area) {
    case "registry":
      return ["src/registry/normalize.ts", "src/registry/sync.ts", "test/unit/upstream-ruleset.test.ts"];
    case "scoring_model":
      return ["src/scoring/model.ts", "src/upstream/ruleset.ts", "test/unit/upstream-ruleset.test.ts"];
    case "issue_discovery":
      return ["src/upstream/ruleset.ts", "src/signals/registration-readiness.ts"];
    case "mirror_linkage":
      return ["src/upstream/ruleset.ts", "src/scoring/model.ts"];
    case "language_weights":
      return ["src/upstream/ruleset.ts", "src/scoring/model.ts"];
    case "source":
      return ["src/upstream/ruleset.ts", "test/contract/upstream-contract.test.ts"];
  }
}

function githubHeaders(token: string | undefined, accept: string): Record<string, string> {
  return {
    accept,
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function rawUrl(config: { repo: string; ref: string }, path: string): string {
  return `https://raw.githubusercontent.com/${config.repo}/${config.ref}/${path}`;
}

function decodeBase64(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g, "")), (char) => char.charCodeAt(0)));
}

function safeJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function numericRecord(value: JsonValue | undefined): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

function recordPayload(value: JsonValue | undefined | unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function firstValue<T>(values: Array<T | null | undefined>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function maxSeverity(left: UpstreamDriftSeverity, right: UpstreamDriftSeverity): UpstreamDriftSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function highestSeverity(values: UpstreamDriftSeverity[]): UpstreamDriftSeverity | null {
  return values.reduce<UpstreamDriftSeverity | null>((highest, severity) => (highest ? maxSeverity(highest, severity) : severity), null);
}

function severityRank(value: UpstreamDriftSeverity): number {
  return { low: 1, medium: 2, high: 3, blocking: 4 }[value];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}
