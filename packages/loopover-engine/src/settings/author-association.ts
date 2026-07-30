// GitHub's `author_association` vocabulary, and the one place this repo decides what it means.
//
// The value comes straight from GitHub on every issue/PR/comment payload and reflects the author's real
// standing in the repository, so it is a MECHANICAL classification: nothing here is a maintained list of
// people, and adding or removing a maintainer upstream changes the answer with no code change. That is
// what makes the per-author-class parity rollups (#9743) reproducible by an outsider -- they can recompute
// the same split from the same public field.
//
// This set was previously spelled out at four independent call sites (the mention-command gate, the
// settings preview, the advisory rules, and local-branch's owner check), one of them lower-cased and one
// of them under a different name. Four copies of a security-relevant predicate is four chances to drift,
// so they now all read this.

/**
 * The associations that mean the author has standing in the repo rather than being a drive-by contributor.
 *
 * `OWNER`/`MEMBER`/`COLLABORATOR` only. Deliberately NOT `CONTRIBUTOR`, which GitHub gives to anyone with
 * a previously-merged PR -- that is a history of contribution, not authority over the repo.
 *
 * Note this is GitHub's *display* association and is not by itself proof of push access (see the note in
 * mcp/server.ts): any surface that will MUTATE something must verify live permissions instead. It is
 * exactly right for classification and reporting, which is what it is used for here.
 */
export const MAINTAINER_AUTHOR_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * How a PR is counted in the parity rollups.
 *
 * `unknown` is its own class rather than being folded into `contributor`: a PR whose association we never
 * recorded is not evidence of anything, and silently counting it as contributor-authored would bias the
 * very comparison the rollups exist to make.
 */
export type AuthorClass = "maintainer" | "contributor" | "unknown";

/** True when the association is one this repo treats as having standing. Case-insensitive: GitHub sends
 *  upper-case, but one existing call site stored it lower-cased. */
export function isMaintainerAuthorAssociation(association: string | null | undefined): boolean {
  if (typeof association !== "string") return false;
  const normalized = association.trim().toUpperCase();
  return MAINTAINER_AUTHOR_ASSOCIATIONS.includes(normalized);
}

/** The author class for a recorded association. Absent/blank is `unknown`, never a guess. */
export function classifyAuthorAssociation(association: string | null | undefined): AuthorClass {
  if (typeof association !== "string" || association.trim() === "") return "unknown";
  return isMaintainerAuthorAssociation(association) ? "maintainer" : "contributor";
}
