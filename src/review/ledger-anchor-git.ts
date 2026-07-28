// Git-commit anchoring backend (#9273, epic #9267). Secondary, complementary to Rekor (#9272): a commit
// appended to `anchors.jsonl` in a public repo, via the GitHub Contents API and the SAME installation-token
// chokepoint (makeInstallationOctokit) every other GitHub write in this engine goes through -- never a
// direct fetch to the GitHub API.
//
// Alone this is weaker than Rekor: GitHub is a trusted third party, and `git push --force` rewrites it. It
// becomes genuinely strong combined with mirrors nobody at LoopOver controls -- GH Archive's hourly
// `PushEvent` export and Software Heritage's on-demand "Save Code Now" archival -- which is why this backend
// exists as a SECOND, independent anchor for the same checkpoint rather than a replacement for Rekor.
//
// Cross-mirror verification, for a skeptic who does not want to trust this repo's own git history alone:
//   1. `git clone` the anchors repo and `git log --oneline -- anchors.jsonl` to find the commit for a seq.
//   2. Cross-check that push actually happened when claimed, from an archive LoopOver does not control:
//        curl -s "https://data.gharchive.org/YYYY-MM-DD-HH.json.gz" | gunzip \
//          | jq 'select(.type=="PushEvent" and .repo.name=="<owner>/<repo>")'
//      A commit present in the anchors repo but ABSENT from that hour's GH Archive export (once the day
//      finishes being written) is exactly the signal a rewrite would leave behind.
import { githubErrorStatus } from "../github/app";
import { canonicalJson, type SignedLedgerAnchor } from "./ledger-anchor";
import { recordLedgerAnchorAttempt } from "./ledger-anchor-persistence";

/** Minimal shape this module needs from an authenticated Octokit -- injectable so tests exercise this
 *  module's OWN append/error logic against a scripted response, never a real GitHub Octokit instance or
 *  network call. The caller (the scheduling job, #9274) constructs the real one via
 *  `makeInstallationOctokit` + `withInstallationTokenRetry`, matching every other GitHub write in this repo;
 *  installation-token resolution is deliberately NOT this module's concern. */
export type GitHubContentsRequester = {
  request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
};

export type LedgerAnchorGitTarget = { owner: string; repo: string; branch: string; path: string };

function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** One JSONL line: the same canonicalized payload and signature Rekor anchors, so the two backends commit to
 *  the identical fact -- never a reshaped or lossy copy. */
export function buildAnchorLogLine(signed: SignedLedgerAnchor): string {
  return `${canonicalJson({ payload: signed.payload, signature: signed.signature, keyId: signed.keyId })}\n`;
}

/**
 * Append one anchor to the JSONL file, via the Contents API's read-modify-write with the file's own `sha` as
 * a compare-and-swap guard (GitHub 409s a stale-sha PUT, which reaches the caller as a normal thrown error --
 * a genuine concurrent-writer race, distinct from every other failure mode this function already handles).
 * Never throws past the caller: any error -- missing repo, auth failure, rate limit, a raced sha -- records a
 * `status: 'failed'` row via #9271's persistence, matching the Rekor backend's identical posture.
 */
export async function submitToGitAnchor(env: Env, signed: SignedLedgerAnchor, octokit: GitHubContentsRequester, target: LedgerAnchorGitTarget): Promise<void> {
  const { owner, repo, branch, path } = target;
  try {
    let existingSha: string | undefined;
    let existingContent = "";
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref: branch });
      const data = response.data as { content?: string; sha?: string; size?: number; encoding?: string };
      // #9489: for a file between 1 MB and 100 MB the Contents API returns `content: ""` with
      // `encoding: "none"` -- and `typeof "" === "string"`, so the old code accepted it as the file's real
      // contents and the PUT below REWROTE the whole log to a single line. At ~300 bytes per line and an
      // hourly cadence that lands roughly 4-5 months out. Git history would still hold the truncated commits,
      // but the file a skeptic is told to read shrinks -- indistinguishable from the tampering this module's
      // own header teaches them to look for. Refuse rather than silently truncate: an operator rotating the
      // file is a deliberate act, and an unanchored tip is loudly visible on the public attempt log (#9271).
      if (data.encoding === "none" || (data.content === "" && (data.size ?? 0) > 0)) {
        throw new Error(
          `anchor log ${path} is too large for the Contents API (size=${data.size ?? "unknown"} bytes); rotate the file or switch to the Git Data API before anchoring can resume`,
        );
      }
      if (typeof data.content === "string") existingContent = decodeBase64(data.content);
      existingSha = data.sha;
    } catch (error) {
      if (githubErrorStatus(error) !== 404) throw error;
      // 404 = first anchor ever committed to this file; start from empty, no sha to compare-and-swap against.
    }

    const updatedContent = existingContent + buildAnchorLogLine(signed);
    const response = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      branch,
      message: `chore(anchor): decision ledger seq ${signed.payload.seq}`,
      content: encodeBase64(updatedContent),
      ...(existingSha !== undefined && { sha: existingSha }),
    });
    const commitSha = (response.data as { commit?: { sha?: string } }).commit?.sha;
    if (typeof commitSha !== "string") {
      await recordLedgerAnchorAttempt(env, {
        payload: signed.payload,
        signature: signed.signature,
        keyId: signed.keyId,
        backend: "git",
        status: "failed",
        error: "GitHub Contents API response did not include a commit sha",
      });
      return;
    }
    await recordLedgerAnchorAttempt(env, {
      payload: signed.payload,
      signature: signed.signature,
      keyId: signed.keyId,
      backend: "git",
      status: "ok",
      backendRef: { owner, repo, branch, path, sha: commitSha },
      proofR2Key: null,
    });
  } catch (error) {
    await recordLedgerAnchorAttempt(env, {
      payload: signed.payload,
      signature: signed.signature,
      keyId: signed.keyId,
      backend: "git",
      status: "failed",
      error,
    });
  }
}
