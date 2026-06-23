// Convergence safety: the hard-guardrail path check for the auto-maintain layer (#778). Changed paths that
// match a repo's hardGuardrailGlobs force MANUAL review — gittensory must never auto-merge OR auto-close a PR
// that touches a guarded path (scoring / auth / CI workflows / policy scripts, etc.). Ported verbatim from
// reviewbot core/change-classifier.ts — the mechanism that prevents the awesome-claude #4196 incident class
// (a weakened policy script auto-merging because its path wasn't guarded). Pure + dependency-free.

/** Convert a path glob (`*` matches within a segment, `**` matches across `/`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        re += ".*";
        i += 1;
        if (glob.charAt(i + 1) === "/") i += 1; // `**/` also matches zero segments
      } else {
        re += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `path` matches any of the globs (`*` within a segment, `**` across `/`). */
export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * The changed paths (if any) that trip a hard guardrail. A non-empty result means the PR touches a guarded
 * path and MUST fall through to a human — gittensory may neither auto-merge nor auto-close it. Pure.
 */
export function changedPathsHittingGuardrail(changedPaths: string[], hardGuardrailGlobs: string[]): string[] {
  if (hardGuardrailGlobs.length === 0) return [];
  return changedPaths.filter((path) => path.length > 0 && matchesAny(path, hardGuardrailGlobs));
}
