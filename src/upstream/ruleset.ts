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
  return { sources, ruleset, drift };
}

export async function loadUpstreamStatus(env: Env): Promise<UpstreamStatus> {
  const [latestRuleset, reports] = await Promise.all([getLatestUpstreamRulesetSnapshot(env), listUpstreamDriftReports(env, 20)]);
  const openReports = reports.filter((report) => report.status === "open");
  const highest = highestSeverity(openReports.map((report) => report.severity));
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
    openReportCount: openReports.length,
    reports: reports.map((report) => publicDriftReport(report)),
  };
}

export async function fileUpstreamDriftIssues(env: Env): Promise<Record<string, JsonValue>> {
  if (!truthy(env.GITTENSORY_AUTO_FILE_DRIFT_ISSUES)) {
    return { status: "disabled", created: 0, updated: 0, skipped: 0 };
  }
  const token = env.GITTENSORY_DRIFT_ISSUE_TOKEN ?? env.GITHUB_PUBLIC_TOKEN;
  if (!token) return { status: "skipped", reason: "missing_issue_token", created: 0, updated: 0, skipped: 0 };
  const repo = env.GITTENSORY_DRIFT_ISSUE_REPO || DEFAULT_DRIFT_ISSUE_REPO;
  const reports = (await listUpstreamDriftReports(env, 20)).filter((report) => report.status === "open" && !report.issueUrl);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const report of reports) {
    const existing = await findGitHubIssueForFingerprint(repo, token, report.fingerprint);
    const issue = existing ?? (await createGitHubDriftIssue(repo, token, report));
    if (!issue) {
      skipped += 1;
      continue;
    }
    await updateUpstreamDriftReportIssue(env, report.fingerprint, issue);
    if (existing) updated += 1;
    else created += 1;
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
  const repoChanges = changedRegistryRepos(previousPayload.registry.repositories, currentPayload.registry.repositories);
  if (repoChanges.length > 0) {
    affected.add("registry");
    raise(repoChanges.some((change) => change.includes("emissionShare")) ? "high" : "medium");
    changes.push(`${repoChanges.length} repo hyperparameter change(s)`);
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
    eligibilityMode: repo.eligibilityMode ?? null,
  };
}

function registryPayload(value: JsonValue | undefined): RulesetPayload["registry"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { repoCount: 0, totalEmissionShare: 0, repositories: [] };
  const payload = value as { repoCount?: JsonValue; totalEmissionShare?: JsonValue; repositories?: JsonValue };
  return {
    repoCount: typeof payload.repoCount === "number" ? payload.repoCount : 0,
    totalEmissionShare: typeof payload.totalEmissionShare === "number" ? payload.totalEmissionShare : 0,
    repositories: Array.isArray(payload.repositories) ? (payload.repositories as RulesetPayload["registry"]["repositories"]) : [],
  };
}

function rulesetPayload(snapshot: UpstreamRulesetSnapshotRecord): RulesetPayload {
  const payload = snapshot.payload as unknown as Partial<RulesetPayload>;
  return {
    upstream: payload.upstream ?? { repo: snapshot.sourceRepo, ref: snapshot.sourceRef, commitSha: snapshot.commitSha },
    registry: payload.registry ?? { repoCount: snapshot.registryRepoCount, totalEmissionShare: snapshot.totalEmissionShare, repositories: [] },
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

function changedRegistryRepos(previous: RulesetPayload["registry"]["repositories"], current: RulesetPayload["registry"]["repositories"]): string[] {
  const previousByRepo = new Map(previous.map((repo) => [repo.repo, repo]));
  return current.flatMap((repo) => {
    const old = previousByRepo.get(repo.repo);
    if (!old) return [`${repo.repo}: added`];
    const changes = [
      ...(repo.emissionShare !== old.emissionShare ? [`emissionShare ${old.emissionShare} -> ${repo.emissionShare}`] : []),
      ...(repo.issueDiscoveryShare !== old.issueDiscoveryShare ? [`issueDiscoveryShare ${old.issueDiscoveryShare} -> ${repo.issueDiscoveryShare}`] : []),
      ...(repo.maintainerCut !== old.maintainerCut ? [`maintainerCut ${old.maintainerCut} -> ${repo.maintainerCut}`] : []),
      ...(stableStringify(repo.labelMultipliers) !== stableStringify(old.labelMultipliers) ? ["labelMultipliers changed"] : []),
      ...(repo.defaultLabelMultiplier !== old.defaultLabelMultiplier ? [`defaultLabelMultiplier ${old.defaultLabelMultiplier ?? "unset"} -> ${repo.defaultLabelMultiplier ?? "unset"}`] : []),
      ...(repo.eligibilityMode !== old.eligibilityMode ? [`eligibilityMode ${old.eligibilityMode ?? "unset"} -> ${repo.eligibilityMode ?? "unset"}`] : []),
    ];
    return changes.length > 0 ? [`${repo.repo}: ${changes.join(", ")}`] : [];
  });
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
  return {
    id: report.id,
    fingerprint: report.fingerprint,
    severity: report.severity,
    status: report.status,
    summary: report.summary,
    affectedAreas: report.affectedAreas,
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
  const body = [
    `<!-- gittensory-upstream-drift:${report.fingerprint} -->`,
    "",
    "## Background",
    "",
    "Gittensory detected upstream Gittensor rule drift that may require code or fixture updates.",
    "",
    "## Drift Summary",
    "",
    `- Severity: ${report.severity}`,
    `- Affected areas: ${report.affectedAreas.join(", ") || "source"}`,
    `- Summary: ${report.summary}`,
    `- Current ruleset: ${report.currentRulesetId ?? "unknown"}`,
    `- Previous ruleset: ${report.previousRulesetId ?? "unknown"}`,
    "",
    "## Required Follow-Up",
    "",
    "- Inspect the upstream ruleset drift report in the private API.",
    "- Update Gittensory parsing/scoring fixtures if the semantic change is expected.",
    "- Keep public GitHub output sanitized and private scoreability details private.",
    "- Run `npm run test:ci` and keep coverage at or above 97%.",
  ].join("\n");
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
    method: "POST",
    headers: githubHeaders(token, "application/vnd.github+json"),
    body: jsonString({
      title: `chore(upstream): reconcile Gittensor drift ${report.fingerprint.slice(0, 8)}`,
      body,
      labels: ["signals", "scoring", "data", report.severity === "high" || report.severity === "blocking" ? "high-impact" : "backend"],
      assignees: ["jsonbored"],
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { number?: number; html_url?: string };
  return payload.number && payload.html_url ? { number: payload.number, url: payload.html_url } : null;
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
