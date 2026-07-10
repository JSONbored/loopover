// Real before/after complexity-delta analyzer (#4740, part of epic #4737's REES/deterministic-tier phase).
// complexity.ts's own `complexity` analyzer explicitly disclaims being a true before/after delta: it normally
// only sees diff hunks, so it can only score a NEWLY-ADDED function (whose opening line is in the diff) against
// a fixed absolute threshold -- a function whose signature is unchanged but whose BODY was edited gets no score
// at all, so a PR that meaningfully SIMPLIFIES a gnarly existing function gets no credit. This analyzer closes
// that gap using the shared reconstructOldContent primitive (#4739): fetch the changed file's post-PR content at
// headSha (the same authed GitHub contents-API fetch doc-comment-drift.ts/exhaustiveness-drift.ts already
// perform for their own purposes), reverse-apply the patch to recover the pre-PR text, run complexity.ts's OWN
// decision-point counting logic (`scanContentForComplexity` -- reused unchanged, not reimplemented) against BOTH
// versions, match functions by name, and diff the two scores.
//
// Registered as a SEPARATE AnalyzerName (`complexityDelta`) rather than folded into `complexity`'s existing
// entry -- see complexity.ts's header for the full reasoning. Short version: merging this network-dependent,
// before/after logic into `complexity`'s single `requires`/`cost` would either (a) gate `complexity`'s existing
// free, local, always-available absolute-threshold check behind `github-token`/`head-sha`, regressing it
// whenever either is unavailable (scheduler.ts's skipReasonForAnalyzer skips a descriptor's `run` entirely based
// on its DECLARED `requires`, before ever calling it -- this is real scheduling behavior, not just docs), or (b)
// mislabel this genuinely network-costed half as `cost: "local"`, letting it dodge the `github-light`
// concurrency/timeout budget and the `fast` profile's network-free guarantee. Two honestly-classified
// descriptors instead of one dishonest one.
//
// A function whose name recurs more than once in either version (ambiguous -- same rule
// scanContentForComplexity/doc-comment-drift.ts's extractFunctionParams already apply) is excluded from
// matching. A function present only in the NEW version has no "before" to diff against -- that is exactly
// `complexity`'s own job, not this analyzer's. A wholly-added file (reconstructOldContent's `""` return) or an
// unreconstructable patch (`null`) are both "no usable before content" and degrade to zero delta findings for
// that file, never a crash -- checked via plain truthiness, NEVER a strict `=== null` compare (see
// reconstruct-old-content.ts's own doc comment: an empty string is falsy but `!== null`, so a strict-null check
// would wrongly treat a brand-new file's "" as valid before-content).
import type { EnrichRequest, ComplexityDeltaFinding } from "../types.js";
import { githubHeaders } from "../github-headers.js";
import { reconstructOldContent } from "./reconstruct-old-content.js";
import { isJsTsPath, scanContentForComplexity } from "./complexity.js";
import { DEFAULT_MAX_FINDINGS } from "./limits.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_FILES = 20;
const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const MAX_FETCH_BYTES = 1_000_000;

interface ScanOptions {
  signal?: AbortSignal;
}

async function readBoundedText(resp: Response, signal?: AbortSignal): Promise<string | null> {
  const length = Number(resp.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FETCH_BYTES) return null;
  if (!resp.body) return null;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FETCH_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchFileAtHeadSha(
  owner: string,
  repo: string,
  path: string,
  headSha: string,
  token: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  try {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const resp = await fetchFn(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(headSha)}`,
      { headers: githubHeaders(token, { raw: true }), signal },
    );
    if (!resp.ok) return null;
    return await readBoundedText(resp, signal);
  } catch {
    return null;
  }
}

/** Full-file-scan the reconstructed OLD content and the NEW (head) content of one file with
 *  complexity.ts's shared `scanContentForComplexity`, and diff every function matched (unambiguously) by name in
 *  both. A function with no change in its measured complexity is not reported -- only a real before/after
 *  difference is a finding, since a "delta" of zero is nothing for the sibling aggregator (#4742) to act on. Pure. */
export function matchAndDiffFunctions(
  file: string,
  oldContent: string,
  newContent: string,
  limits: { maxFindings?: number } = {},
): ComplexityDeltaFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];

  const oldScores = scanContentForComplexity(oldContent);
  const newScores = scanContentForComplexity(newContent);

  const findings: ComplexityDeltaFinding[] = [];
  for (const [name, after] of newScores) {
    const before = oldScores.get(name);
    if (!before || before.complexity === after.complexity) continue;
    findings.push({
      file,
      line: after.line,
      name,
      before: before.complexity,
      after: after.complexity,
      delta: after.complexity - before.complexity,
    });
    if (findings.length >= maxFindings) break;
  }
  return findings;
}

/** Analyzer entrypoint: for each changed JS/TS source file, reconstruct its pre-PR content and diff real
 *  before/after complexity per function. Fail-safe -- never throws on a missing token/headSha, an
 *  unreconstructable patch, or a fetch error; each degrades to zero findings for that file rather than a crash
 *  or a guessed answer. */
export async function scanComplexityDelta(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<ComplexityDeltaFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const sources = files.filter((file) => file.patch && isJsTsPath(file.path)).slice(0, MAX_FILES);

  const findings: ComplexityDeltaFinding[] = [];
  for (const file of sources) {
    if (options.signal?.aborted) break;

    const headContent = await fetchFileAtHeadSha(
      owner,
      repo,
      file.path,
      headSha,
      githubToken,
      fetchFn,
      options.signal,
    );
    if (!headContent) continue;
    if (options.signal?.aborted) break; // an abort during the fetch should suppress this file's findings too

    // `reconstructOldContent` returns EITHER `null` (patch didn't reverse-apply -- malformed/mismatched) OR `""`
    // (patch reverse-applied cleanly but the file is wholly new -- no old-side content at all). Both are "no
    // usable before content" and must be treated identically via truthiness; a strict `=== null` check would
    // wrongly treat the wholly-new-file "" as valid before-content.
    const oldContent = reconstructOldContent(headContent, file.patch!);
    if (!oldContent) continue;

    for (const finding of matchAndDiffFunctions(file.path, oldContent, headContent, {
      maxFindings: MAX_FINDINGS - findings.length,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
