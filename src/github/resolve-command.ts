// #2166 `@gittensory resolve [<finding-id>]` — pure finding-reference normalization for the resolve dispatch
// scaffold. A maintainer marks a posted review finding (or the whole PR's findings) as resolved; suppression
// semantics that feed a future review pass are maintainer-owned (#1964). This module only validates the optional
// trailing argument so the processor can record `github_app.finding_resolved` with a stable finding key.

const RESOLVE_FINDING_CODE = /^[a-z][a-z0-9_]{0,199}$/;

export type ResolveFindingRef =
  | { ok: true; scope: "whole_pr" }
  | { ok: true; scope: "single"; findingCode: string }
  | { ok: false; reason: "malformed_finding_id" };

/** Normalize the optional trailing text from `@gittensory resolve [<finding-id>]`. Empty/absent ⇒ whole-PR ack;
 *  a present token must be a public-safe finding code (snake_case, optional `finding-` prefix). PURE. */
export function normalizeResolveFindingRef(raw: string | null | undefined): ResolveFindingRef {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { ok: true, scope: "whole_pr" };
  const normalized = trimmed.toLowerCase().replace(/^finding-/, "");
  if (!RESOLVE_FINDING_CODE.test(normalized)) return { ok: false, reason: "malformed_finding_id" };
  return { ok: true, scope: "single", findingCode: normalized };
}
