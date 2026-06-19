import { DEFAULT_SCORING_CONSTANTS } from "../scoring/model";
import type { JsonValue, RegistryRepoConfig, RegistrySnapshot, RepoTimeDecayOverrides } from "../types";

type RawRepoConfig = Record<string, JsonValue>;

export function normalizeRegistryPayload(payload: unknown, source: RegistrySnapshot["source"], fetchedAt: string): RegistrySnapshot {
  const repos = extractRepoEntries(payload).map(([repo, config]) => normalizeRepo(repo, config));
  const totalEmissionShare = repos.reduce((sum, repo) => sum + repo.emissionShare, 0);
  return {
    id: crypto.randomUUID(),
    generatedAt: fetchedAt,
    fetchedAt,
    source,
    repoCount: repos.length,
    totalEmissionShare,
    warnings: [],
    repositories: repos.sort((left, right) => right.emissionShare - left.emissionShare),
  };
}

function extractRepoEntries(payload: unknown): Array<[string, RawRepoConfig]> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const objectPayload = payload as Record<string, unknown>;
    if (Array.isArray(objectPayload.repositories)) {
      return objectPayload.repositories.flatMap((repo) => {
        if (!repo || typeof repo !== "object") return [];
        const raw = repo as RawRepoConfig;
        const name = stringValue(raw.repo) ?? stringValue(raw.full_name) ?? stringValue(raw.repository_full_name);
        return name ? [[name, raw] as [string, RawRepoConfig]] : [];
      });
    }
    return Object.entries(objectPayload).flatMap(([repo, config]) => {
      if (!config || typeof config !== "object" || Array.isArray(config)) return [];
      return [[repo, config as RawRepoConfig] as [string, RawRepoConfig]];
    });
  }
  if (Array.isArray(payload)) {
    return payload.flatMap((repo) => {
      if (!repo || typeof repo !== "object") return [];
      const raw = repo as RawRepoConfig;
      const name = stringValue(raw.repo) ?? stringValue(raw.full_name) ?? stringValue(raw.repository_full_name);
      return name ? [[name, raw] as [string, RawRepoConfig]] : [];
    });
  }
  return [];
}

function normalizeRepo(repo: string, config: RawRepoConfig): RegistryRepoConfig {
  const rawLabelMultipliers = config.label_multipliers;
  const labelMultipliers =
    rawLabelMultipliers && typeof rawLabelMultipliers === "object" && !Array.isArray(rawLabelMultipliers)
      ? Object.fromEntries(
          Object.entries(rawLabelMultipliers).flatMap(([key, value]) =>
            typeof value === "number" ? [[key, value] as [string, number]] : [],
          ),
        )
      : {};
  return {
    repo,
    emissionShare: numberValue(config.emission_share) ?? 0,
    issueDiscoveryShare: numberValue(config.issue_discovery_share) ?? DEFAULT_SCORING_CONSTANTS.DEFAULT_ISSUE_DISCOVERY_SHARE ?? 0.5,
    labelMultipliers,
    trustedLabelPipeline: booleanValue(config.trusted_label_pipeline),
    maintainerCut: numberValue(config.maintainer_cut) ?? 0,
    defaultLabelMultiplier: numberValue(config.default_label_multiplier),
    fixedBaseScore: numberValue(config.fixed_base_score),
    eligibilityMode: stringValue(config.eligibility_mode),
    timeDecay: parseTimeDecayOverrides(config.scoring),
    raw: config,
  };
}

// Per-repo time-decay overrides (#703), from the registry's nested `scoring.time_decay` (the same source
// upstream reads). Each key is optional; absent/non-numeric → null (resolveTimeDecay falls back to the
// global default). Returns null when there is no usable override, so a repo without one uses all defaults.
function parseTimeDecayOverrides(scoring: JsonValue | undefined): RepoTimeDecayOverrides | null {
  if (!scoring || typeof scoring !== "object" || Array.isArray(scoring)) return null;
  const raw = (scoring as Record<string, JsonValue>).time_decay;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const td = raw as Record<string, JsonValue>;
  const overrides: RepoTimeDecayOverrides = {
    gracePeriodHours: numberValue(td.grace_period_hours),
    sigmoidMidpointDays: numberValue(td.sigmoid_midpoint_days),
    sigmoidSteepness: numberValue(td.sigmoid_steepness),
    minMultiplier: numberValue(td.min_multiplier),
  };
  return Object.values(overrides).some((value) => value !== null) ? overrides : null;
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}
