import {
  getBurdenForecast,
  getRepository,
  listIssueSignalSample,
  listOpenPullRequests,
  listRecentMergedPullRequests,
} from "../db/repositories";
import { buildBurdenForecast, buildCollisionReport, type BurdenForecast } from "../signals/engine";

export const BURDEN_FORECAST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type BurdenForecastFreshness = "fresh" | "stale";

export type BurdenForecastResponse = {
  status: "ready";
  source: "snapshot" | "computed";
  repoFullName: string;
  generatedAt: string;
  ageSeconds: number;
  freshness: BurdenForecastFreshness;
  report: BurdenForecast;
};

export async function loadOrComputeBurdenForecastResponse(env: Env, fullName: string): Promise<BurdenForecastResponse | null> {
  const cached = await getBurdenForecast(env, fullName);
  if (cached) {
    const ageMs = forecastAgeMs(cached.generatedAt);
    return {
      status: "ready",
      source: "snapshot",
      repoFullName: fullName,
      generatedAt: cached.generatedAt,
      ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
      freshness: ageMs > BURDEN_FORECAST_MAX_AGE_MS ? "stale" : "fresh",
      report: cached.payload as unknown as BurdenForecast,
    };
  }
  const repo = await getRepository(env, fullName);
  if (!repo) return null;
  const [issues, pullRequests, recentMergedPullRequests] = await Promise.all([
    listIssueSignalSample(env, fullName),
    listOpenPullRequests(env, fullName),
    listRecentMergedPullRequests(env, fullName),
  ]);
  const collisions = buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  const report = buildBurdenForecast(repo, issues, pullRequests, collisions, 30);
  return {
    status: "ready",
    source: "computed",
    repoFullName: fullName,
    generatedAt: report.generatedAt,
    ageSeconds: 0,
    freshness: "fresh",
    report,
  };
}

function forecastAgeMs(generatedAt: string): number {
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}
