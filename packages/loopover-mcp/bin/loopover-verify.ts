#!/usr/bin/env node
// `loopover-verify` — the one-command public verifier (#9723, epic #9722).
//
//   npx -p @loopover/mcp loopover-verify
//
// Fetches LoopOver's public fairness surfaces, RECOMPUTES every commitment they publish, and prints a
// per-claim PASS/FAIL table. Exits non-zero if any claim fails, so it is usable as a CI assertion by
// somebody who does not trust us -- which is the only kind of verification that means anything.
//
// ZERO CREDENTIALS, BY CONSTRUCTION. Every path fetched below is under `/v1/public/`, no Authorization
// header is ever set, and no token is read from the environment. A verifier that needed our credentials
// would be verifying nothing; the point is that a stranger on a clean machine gets the same answer we do.
//
// The checks themselves live in `../lib/verify-public-claims.js` and are pure. This file is only: parse
// argv, fetch, render, exit.
import { argsWantJson, describeCliError, reportCliFailure } from "../lib/cli-error.js";
import { formatTable } from "../lib/format-table.js";
import {
  checkAnchorCheckpoint,
  checkCorpusCommitments,
  checkRecordDigests,
  checkStatsParity,
  exitCodeFor,
  summarize,
  type ClaimResult,
  type VerifiableEvalRecord,
} from "../lib/verify-public-claims.js";

const defaultApiUrl = "https://api.loopover.ai";

/** Per-request timeout. A verifier that hangs forever on one unreachable surface is worse than one that
 *  reports that surface as unreachable and carries on with the rest. */
const requestTimeoutMs = 15_000;

type FetchOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function usage(): string {
  return [
    "loopover-verify — independently verify LoopOver's published fairness claims.",
    "",
    "Usage: npx -p @loopover/mcp loopover-verify [options]",
    "",
    "Options:",
    "  --base-url <url>   API base to verify (default: " + defaultApiUrl + ")",
    "  --json             emit machine-readable results instead of a table",
    "  --help             show this message",
    "",
    "Exits 0 when every checked claim passes, 1 when any claim fails, 2 on a usage error.",
    "Requires no credentials of any kind.",
  ].join("\n");
}

/** Read `--base-url`, normalising away a trailing slash so path joins cannot double up. */
export function parseBaseUrl(args: readonly string[], fallback = defaultApiUrl): { ok: true; baseUrl: string } | { ok: false; error: string } {
  const index = args.indexOf("--base-url");
  if (index === -1) return { ok: true, baseUrl: fallback.replace(/\/+$/, "") };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return { ok: false, error: "--base-url requires a URL" };
  try {
    // Constructed rather than regex-checked: `new URL` is the same parser the fetch below will use, so a
    // value that passes here cannot fail differently later.
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: `--base-url must be http(s), got "${parsed.protocol}"` };
  } catch {
    return { ok: false, error: `--base-url is not a valid URL: "${value}"` };
  }
  return { ok: true, baseUrl: value.replace(/\/+$/, "") };
}

/**
 * GET a public JSON endpoint. Never throws and never sends credentials: a failed fetch becomes a described
 * outcome the caller turns into a `skip`, so one unavailable surface cannot abort the whole run and hide
 * the claims that WOULD have been checkable.
 */
async function apiGet<T>(baseUrl: string, path: string): Promise<FetchOutcome<T>> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: describeCliError(error) };
  }
}

/** Render one claim's row. The status column is a bare word so the output greps and diffs cleanly. */
function renderTable(results: readonly ClaimResult[]): string {
  return formatTable({
    headers: [
      { key: "status", label: "RESULT" },
      { key: "claim", label: "CLAIM" },
      { key: "detail", label: "DETAIL" },
    ],
    rows: results.map((result) => ({ status: result.status.toUpperCase(), claim: result.claim, detail: result.detail })),
  });
}

export async function runVerify(args: readonly string[], baseUrlOverride?: string): Promise<number> {
  const wantsJson = argsWantJson(args);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const parsed = parseBaseUrl(args, baseUrlOverride ?? defaultApiUrl);
  if (!parsed.ok) return reportCliFailure(wantsJson, parsed.error);
  const { baseUrl } = parsed;

  // Fetched together: they are independent reads, and a verifier that serialises four round trips for no
  // reason is a slower verifier with no compensating property.
  const [scoresOutcome, statsOutcome, checkpointOutcome, keysOutcome] = await Promise.all([
    apiGet<{ records?: VerifiableEvalRecord[] }>(baseUrl, "/v1/public/eval-scores"),
    apiGet<{ totals?: { handled?: unknown }; reviewParity?: { verdicts?: unknown } }>(baseUrl, "/v1/public/stats"),
    apiGet<{ signed?: unknown; signingInput?: unknown }>(baseUrl, "/v1/public/decision-ledger/anchor-payload"),
    apiGet<{ keys?: unknown[] }>(baseUrl, "/v1/public/decision-ledger/anchor-key"),
  ]);

  const records = scoresOutcome.ok && Array.isArray(scoresOutcome.value.records) ? scoresOutcome.value.records : [];

  // One corpus fetch per rule a record actually commits to -- not a blind enumeration. A rule with no
  // published corpus simply stays absent from the map, which `checkCorpusCommitments` reports honestly.
  const ruleIds = [...new Set(records.map((record) => record.workUnit?.ruleId).filter((ruleId): ruleId is string => typeof ruleId === "string"))];
  const corpusEntries = await Promise.all(
    ruleIds.map(async (ruleId) => {
      // `ruleId`, not `rule_id` (#9962). The route has only ever read the camelCase spelling -- the snake_case
      // one 400s -- so every corpus fetch this verifier made came back empty and the corpus claim degraded to
      // "nothing could be rehashed" against a deployment that was publishing a perfectly good corpus. The
      // camelCase spelling is what the OpenAPI spec and the docs have always documented, so it works against
      // every deployment, old and new; the alias the route now also accepts is there for verifiers already
      // installed in the wild, not for this one.
      const outcome = await apiGet<{ cases?: unknown; checksum?: unknown }>(baseUrl, `/v1/public/eval-corpus?ruleId=${encodeURIComponent(ruleId)}`);
      return [ruleId, outcome.ok ? outcome.value : undefined] as const;
    }),
  );

  const results: ClaimResult[] = [];
  if (!scoresOutcome.ok) {
    results.push({ id: "record-digests", claim: "Every eval-score record's recordDigest recomputes from its own contents", status: "skip", detail: `/v1/public/eval-scores unavailable (${scoresOutcome.error})` });
    results.push({ id: "corpus-commitments", claim: "Every corpusChecksum matches a downloadable corpus, and no scored record commits to an empty one", status: "skip", detail: `/v1/public/eval-scores unavailable (${scoresOutcome.error})` });
  } else {
    results.push(await checkRecordDigests(records));
    results.push(await checkCorpusCommitments(records, new Map(corpusEntries)));
  }

  // A 404 here is the DOCUMENTED "anchor signing not configured / ledger empty" response, not an outage,
  // so an unavailable checkpoint is passed through as `undefined` and reported as a skip by the check
  // itself rather than being special-cased into a second, subtly different skip message here.
  const keys = keysOutcome.ok && Array.isArray(keysOutcome.value.keys) ? (keysOutcome.value.keys as Parameters<typeof checkAnchorCheckpoint>[1]) : [];
  results.push(await checkAnchorCheckpoint(checkpointOutcome.ok ? checkpointOutcome.value : undefined, keys));

  results.push(
    statsOutcome.ok
      ? checkStatsParity(statsOutcome.value, statsOutcome.value.reviewParity)
      : { id: "stats-parity", claim: "Published headline stats agree with the ledger-derived parity rollups", status: "skip", detail: `/v1/public/stats unavailable (${statsOutcome.error})` },
  );

  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({ baseUrl, results, summary: summarize(results) }, null, 2)}\n`);
  } else {
    process.stdout.write(`Verifying ${baseUrl} (no credentials used)\n\n${renderTable(results)}\n\n${summarize(results)}\n`);
  }
  return exitCodeFor(results);
}

// Only self-executes as a real CLI. Importing this file in a test must not run the verifier or call
// process.exit -- see the in-process CLI harness pattern the other bins' tests use.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runVerify(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.exitCode = reportCliFailure(argsWantJson(process.argv.slice(2)), describeCliError(error));
    });
}
