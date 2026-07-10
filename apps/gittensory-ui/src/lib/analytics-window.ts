export const ANALYTICS_WINDOW_OPTIONS = [7, 30, 90] as const;
export type AnalyticsWindowDays = (typeof ANALYTICS_WINDOW_OPTIONS)[number];
export const DEFAULT_ANALYTICS_WINDOW_DAYS: AnalyticsWindowDays = 7;
export const ANALYTICS_WINDOW_STORAGE_KEY = "gittensory.analytics.windowDays";

export function parseAnalyticsWindowDays(value: unknown): AnalyticsWindowDays {
  const numeric = Number(value);
  return ANALYTICS_WINDOW_OPTIONS.includes(numeric as AnalyticsWindowDays)
    ? (numeric as AnalyticsWindowDays)
    : DEFAULT_ANALYTICS_WINDOW_DAYS;
}

export function operatorDashboardPath(windowDays: AnalyticsWindowDays): string {
  return `/v1/app/operator-dashboard?days=${windowDays}`;
}
