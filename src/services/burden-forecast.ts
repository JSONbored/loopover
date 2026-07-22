import { getBurdenForecast, getRepository } from "../db/repositories";
import type { BurdenForecast } from "../signals/engine";

export const BURDEN_FORECAST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type BurdenForecastFreshness = "fresh" | "stale";

export type BurdenForecastResponse = {
  status: "ready";
  // Cache-only: the request-time compute path was removed in #906 (moved to the background
  // `buildBurdenForecasts` job), so a response is always served from a stored snapshot (#8019).
  source: "snapshot";
  repoFullName: string;
  generatedAt: string;
  ageSeconds: number;
  freshness: BurdenForecastFreshness;
  report: BurdenForecast;
};

/**
 * Load the stored burden-forecast snapshot for a repo, or null when none is cached. This is cache-only
 * (#8019): the inline compute fallback was removed in #906 and now runs as the background
 * `buildBurdenForecasts` job (`src/queue/processors.ts`), which is what populates the snapshot read here.
 */
export async function loadCachedBurdenForecastResponse(env: Env, fullName: string): Promise<BurdenForecastResponse | null> {
  const repo = await getRepository(env, fullName);
  if (!repo) return null;

  const repoFullName = repo.fullName;
  const cached = await getBurdenForecast(env, repoFullName);
  if (cached) {
    const ageMs = forecastAgeMs(cached.generatedAt);
    return {
      status: "ready",
      source: "snapshot",
      repoFullName,
      generatedAt: cached.generatedAt,
      ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
      freshness: ageMs > BURDEN_FORECAST_MAX_AGE_MS ? "stale" : "fresh",
      report: cached.payload as unknown as BurdenForecast,
    };
  }
  return null;
}

function forecastAgeMs(generatedAt: string): number {
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}
