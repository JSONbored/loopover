/**
 * Resolve the actionlint download-retry attempt count from a raw env value (ACTIONLINT_DOWNLOAD_ATTEMPTS).
 *
 * Uses an explicit finiteness check rather than a `Number.parseInt(...) || 4` fallback (#7773): `0` is falsy
 * in JS, so `Number.parseInt("0", 10) || 4` wrongly yields 4, silently ignoring an operator's explicit `"0"`.
 * A missing/blank/non-integer value defaults to 4; any parsed integer is honored and floored to a minimum of
 * 1. Mirrors the validation shape in migrate-selfhost-sqlite-to-postgres.ts (`Number.isFinite`, not `||`).
 *
 * @param {string | undefined} raw
 * @returns {number} attempt count, always >= 1
 */
export function resolveActionlintDownloadAttempts(raw) {
  const parsed = Number.parseInt(raw ?? "4", 10);
  return Math.max(1, Number.isFinite(parsed) ? parsed : 4);
}
