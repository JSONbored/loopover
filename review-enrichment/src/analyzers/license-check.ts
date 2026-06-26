// SPDX license policy analyzer (#1475). For each dependency a PR adds/upgrades, resolves its SPDX license via
// deps.dev (free, no key, covers npm/PyPI/Go) and flags the ones a maintainer should eyeball: copyleft (may be
// incompatible with a permissive project) or unresolved/unknown. Permissive licenses (MIT/BSD/Apache/…) are not
// flagged. The no-checkout reviewer can't resolve a dependency's published license — this can.
import type { EnrichRequest, LicenseFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

// REES ecosystem label → deps.dev system path segment.
const SYSTEM: Record<string, string> = { npm: "npm", PyPI: "pypi", Go: "go" };

// Strong/weak copyleft families worth a compatibility check against a permissive project.
const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|SSPL|CPAL|CECILL)/i;

function classify(licenses: string[]): LicenseFinding["classification"] | null {
  const resolved = licenses.filter(
    (license) => license && !/^NOASSERTION$/i.test(license),
  );
  if (!resolved.length) return "unknown";
  if (resolved.some((license) => COPYLEFT.test(license))) return "copyleft";
  return null; // permissive / otherwise-known → not flagged
}

// null ⇒ couldn't determine (don't flag); [] / ["NOASSERTION"] ⇒ resolved-but-unknown (flag).
async function fetchLicenses(
  system: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<string[] | null> {
  const url = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  const response = await fetchImpl(url);
  if (!response.ok) return null;
  const data = (await response.json()) as { licenses?: string[] };
  return Array.isArray(data.licenses) ? data.licenses : [];
}

/** Analyzer entrypoint: changed deps → deps.dev license → only the copyleft/unknown ones. */
export async function scanLicenses(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<LicenseFinding[]> {
  const findings: LicenseFinding[] = [];
  for (const change of extractDependencyChanges(req.files ?? [])) {
    const system = SYSTEM[change.ecosystem];
    if (!system) continue;
    const licenses = await fetchLicenses(
      system,
      change.package,
      change.to,
      fetchImpl,
    );
    if (licenses === null) continue; // resolution failed — don't false-flag
    const classification = classify(licenses);
    if (classification) {
      findings.push({
        ecosystem: change.ecosystem,
        package: change.package,
        version: change.to,
        licenses,
        classification,
      });
    }
  }
  return findings;
}
