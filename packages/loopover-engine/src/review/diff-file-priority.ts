import { isLockfile } from "../signals/path-matchers.js";
import { isTestPath } from "../signals/test-evidence.js";

export function diffFilePriority(path: string): number {
  // Lockfile-NAME matching delegates to the canonical isLockfile/LOCKFILE_NAMES so no copy of this
  // function can drift from the shared set (the #4605 Finding 1 class); suffix patterns stay inline.
  if (isLockfile(path) || /\.(min\.(js|css)|map|snap)$/i.test(path)) return 4;
  // Must stay in sync with signals/path-matchers.ts's isVendoredFileFrom -- the two already had this
  // obligation implicitly (bower_components/jspm_packages were added there in #2777 with no corresponding
  // update here, #7526) and now match the same directory-name set exactly.
  if (/(^|\/)(dist|build|out|coverage|vendor|vendored|third_party|third-party|node_modules|bower_components|jspm_packages)\//i.test(path)) return 4;
  if (/\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i.test(path)) return 2;
  if (isTestPath(path)) return 1;
  return 0;
}
