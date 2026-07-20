const DEFAULT_API_ORIGIN = "https://api.loopover.ai";

// #7534: warn at most once when the origin was NOT explicitly configured, so a self-host deployment that
// forgot to set VITE_LOOPOVER_API_ORIGIN at build time notices the UI is silently targeting the default
// hosted API instead of its own. Gated on the env var being empty/unset — NOT on the resolved value
// equalling the default — so someone who deliberately points at the hosted origin gets no warning.
let warnedUnconfiguredOrigin = false;

export function getApiOrigin(): string {
  const configured = import.meta.env.VITE_LOOPOVER_API_ORIGIN?.trim();
  if (!configured && !warnedUnconfiguredOrigin) {
    warnedUnconfiguredOrigin = true;
    console.warn(
      `VITE_LOOPOVER_API_ORIGIN is not set — the UI is targeting the default hosted API origin ` +
        `${DEFAULT_API_ORIGIN}. Self-host deployments should set VITE_LOOPOVER_API_ORIGIN=https://your-api.example.com ` +
        `at build time to point the UI at their own API.`,
    );
  }
  const origin = configured || DEFAULT_API_ORIGIN;
  return origin.replace(/\/+$/, "");
}
