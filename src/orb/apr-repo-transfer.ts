// APR (Rent-a-Loop, #7173) repo-transfer-to-customer initiation (#7638, implementing #7590's decision that APR
// customers get an explicit transfer-to-their-own-account flow rather than owning the repo from day one). This
// kicks off GitHub's standard repository-transfer mechanism from the loopover-controlled org to a customer's own
// account, authenticated with the Orb App's installation token — the SAME token source the sibling repo-creation
// flow uses (src/orb/app-auth.ts's createOrbInstallationToken).
//
// GitHub transfers are asynchronous and acceptance-gated: the recipient must accept a confirmation email within a
// time window, and the transfer does NOT complete synchronously. So this module's job is only to *initiate* the
// transfer and report what GitHub's response says — never to assume the transfer is done. Detecting when a
// pending transfer is accepted or expires is a separate, out-of-scope concern.
import { githubHeaders, timeoutFetch } from "../github/client";
import { createOrbInstallationToken } from "./app-auth";

// A repo transfer is a one-shot POST. Give it the same generous window as the token mint (app-auth.ts) so a
// throttled App doesn't spuriously abort an otherwise-fine request.
const REPO_TRANSFER_TIMEOUT_MS = 25_000;

// `repoFullName` goes straight into the request URL's path, so it must be a plain `owner/repo` pair — the only
// characters GitHub allows in a login or repo name (alphanumerics plus `-`, `_`, `.`). Rejecting anything else up
// front stops a value carrying URL metacharacters (`?`, `#`, extra `/`, …) from silently redirecting the POST to
// a different endpoint. GitHub logins/repos can't legally contain those, so a match here is never a false reject.
const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Outcome of initiating a repo transfer.
 *
 *  `initiated: true` means GitHub ACCEPTED the transfer request (HTTP 202) — it does NOT mean the customer has
 *  accepted it or that the repo has moved. That acceptance is a separate, later event and is out of scope here.
 *  `initiated: false` carries GitHub's HTTP status and (truncated) error body so a caller can tell "target
 *  account doesn't exist" (404) apart from "caller lacks admin access" (403) without catching an exception. A
 *  locally-rejected malformed `repoFullName` (see `REPO_FULL_NAME_PATTERN`) uses `status: 0` to signal that no
 *  request was ever sent to GitHub. */
export type AprRepoTransferResult =
  | { initiated: true; status: number; repo: string; newOwner: string }
  | { initiated: false; status: number; error: string };

/** Initiate a GitHub repository transfer of `repoFullName` (an `owner/repo` in the loopover-controlled org) to
 *  `newOwner` (the target GitHub account login), authenticated with the Orb App installation token minted for
 *  `installationId` (the same token source repo-creation uses).
 *
 *  IMPORTANT — "initiated" is NOT "complete". A successful response (`initiated: true`) means the transfer has
 *  been *initiated*: GitHub has recorded a pending transfer that the recipient must still accept via a
 *  confirmation email within a time window. Anything built on top of this MUST treat `initiated: true` as "a
 *  transfer is now pending the recipient's acceptance", never as "the repo now belongs to `newOwner`". A
 *  GitHub-side rejection (unknown target account, missing admin access, …) is returned as `initiated: false` with
 *  the status and message rather than thrown, so an expected transfer failure never surfaces as an unhandled
 *  exception. */
export async function initiateAprRepoTransfer(
  env: Env,
  installationId: number,
  repoFullName: string,
  newOwner: string,
): Promise<AprRepoTransferResult> {
  // Guard the URL path before spending a token mint or a network round-trip: a `repoFullName` with URL
  // metacharacters could otherwise redirect the POST to an unintended endpoint.
  if (!REPO_FULL_NAME_PATTERN.test(repoFullName)) {
    return {
      initiated: false,
      status: 0,
      error: `invalid repoFullName: ${repoFullName.slice(0, 200)}`,
    };
  }
  const { token } = await createOrbInstallationToken(env, installationId);
  const response = await timeoutFetch(
    `https://api.github.com/repos/${repoFullName}/transfer`,
    {
      method: "POST",
      headers: githubHeaders({ token, json: true }),
      body: JSON.stringify({ new_owner: newOwner }),
      signal: AbortSignal.timeout(REPO_TRANSFER_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    return {
      initiated: false,
      status: response.status,
      error: body.slice(0, 200),
    };
  }
  return {
    initiated: true,
    status: response.status,
    repo: repoFullName,
    newOwner,
  };
}
