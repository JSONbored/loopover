// #2315 miner soft-claim spec builder. A miner can OPTIONALLY make its claim visible to a fleet by posting a public
// "soft claim" comment ("a miner is working on this") to reduce duplicate work. This module composes a
// deterministic, well-formatted claim comment BODY and hands it to the EXISTING `buildPostEligibilityCommentSpec`
// — it BUILDS the spec only and never executes anything, so the same spec-builder-not-actuator boundary documented
// by `src/mcp/local-write-tools.ts` (see `LOCAL_WRITE_BOUNDARY`, local-write-tools.ts:8) holds: the miner's OWN
// harness runs the command with its OWN GitHub credentials. Shell-safety is inherited from the reused builder's
// single-quote escaping — never re-implemented here.
import {
  buildPostEligibilityCommentSpec,
  type LocalWriteActionSpec,
} from "../mcp/local-write-tools";

/** Format the deterministic Markdown body of a soft-claim comment: which miner claimed the issue, when, and — when
 *  provided — when the claim lapses. Pure: the same inputs always produce the same string. The body's shell-safety
 *  is guaranteed downstream by {@link buildSoftClaimSpec} reusing `local-write-tools`' single-quote escaping. */
export function buildSoftClaimCommentBody(input: { minerId: string; claimedAt: string; expiresAt?: string }): string {
  const lines = [
    `🤖 **Soft claim** — a Gittensor miner (\`${input.minerId}\`) is working on this issue, claimed at ${input.claimedAt}.`,
  ];
  if (input.expiresAt) {
    lines.push(
      `This claim expires at ${input.expiresAt}; if no PR has landed by then, the issue is open for others again.`,
    );
  }
  lines.push("_Soft claim only — not an assignment. It signals intent so the fleet avoids duplicate work._");
  return lines.join("\n\n");
}

/** Build the local-write action spec that posts a soft-claim comment on an issue. Composes
 *  {@link buildSoftClaimCommentBody} and delegates to the EXISTING `buildPostEligibilityCommentSpec` — reusing its
 *  shell-safe command construction/escaping rather than duplicating it — so the output stays deterministic and
 *  single-quote-shell-safe. Builds the spec only; the miner's own harness runs it (see `LOCAL_WRITE_BOUNDARY`). */
export function buildSoftClaimSpec(input: {
  repoFullName: string;
  number: number;
  minerId: string;
  claimedAt: string;
  expiresAt?: string;
}): LocalWriteActionSpec {
  const body = buildSoftClaimCommentBody(input);
  return buildPostEligibilityCommentSpec({ repoFullName: input.repoFullName, number: input.number, body });
}
