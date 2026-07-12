// Shared PR-number extraction from a real `gh pr create` executeLocalWrite result (#4848). `gh pr create`
// prints the new PR's URL to stdout on success -- this is the one place that URL is authoritatively parsed,
// so loop-cli.js's CI/gate-status polling and attempt-cli.js's post-submission claim-conflict check agree on
// exactly how a PR number is recovered from a real command's raw output.

/** `gh pr create` (local-write-tools.ts's `buildOpenPrSpec` -- no `--json` flag) prints the created PR's own
 *  URL to stdout on success; this is `gh`'s real, documented, stable CLI behavior, not an invented contract.
 *  Scoped to the exact target repo so an unrelated URL elsewhere in stdout/stderr noise can never match.
 *
 * @param {{ stdout?: string, code?: number | null, timedOut?: boolean } | null | undefined} execResult
 * @param {string} repoFullName
 * @returns {number | null}
 */
export function parsePrNumberFromExecResult(execResult, repoFullName) {
  if (!execResult || execResult.timedOut || execResult.code !== 0 || typeof execResult.stdout !== "string") {
    return null;
  }
  const escapedRepo = repoFullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = execResult.stdout.match(new RegExp(`github\\.com/${escapedRepo}/pull/(\\d+)`));
  if (!match) return null;
  const prNumber = Number(match[1]);
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}
