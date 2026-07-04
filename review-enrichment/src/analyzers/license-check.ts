// SPDX license policy analyzer (#1475). For each dependency a PR adds/upgrades, resolves its SPDX license via
// deps.dev (free, no key, covers npm/PyPI/Go) and flags the ones a maintainer should eyeball: copyleft (may be
// incompatible with a permissive project) or unresolved/unknown. Permissive licenses (MIT/BSD/Apache/…) are not
// flagged. The no-checkout reviewer can't resolve a dependency's published license — this can.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  LicenseFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { extractDependencyChanges } from "./dependency-scan.js";
import { boundedFetchJson } from "../external-fetch.js";

// REES ecosystem label → deps.dev system path segment.
const SYSTEM: Record<string, string> = { npm: "npm", PyPI: "pypi", Go: "go" };

// Strong/weak copyleft families worth a compatibility check against a permissive project. GFDL (the GNU
// documentation copyleft, sibling of the GPL/LGPL/AGPL families above), CC-BY-SA (Creative Commons
// ShareAlike — the `-SA` variant is copyleft, unlike plain CC-BY/CC0), QPL, and Sleepycat are all
// reciprocal/copyleft SPDX ids that were previously classified as permissive and slipped through unflagged.
const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|SSPL|CPAL|CECILL|GFDL|CC-BY-SA|QPL|Sleepycat)/i;
const MAX_LICENSE_LOOKUPS = 25;
const LICENSE_LOOKUP_TIMEOUT_MS = 1500;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

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
  options: ScanOptions,
): Promise<string[] | null> {
  const url = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  const fetchOptions = {
    endpointCategory: "deps-dev",
    signal: options.signal,
    timeoutMs: LICENSE_LOOKUP_TIMEOUT_MS,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "license",
    subcall: "deps-dev",
    maxBytes: 256 * 1024,
    maxCallsPerCategory: MAX_LICENSE_LOOKUPS,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<{ licenses?: string[] }>(url, fetchOptions)
    : await boundedFetchJson<{ licenses?: string[] }>(url, fetchOptions);
  if (!response.ok) return null;
  return Array.isArray(response.data.licenses) ? response.data.licenses : [];
}

/** Analyzer entrypoint: changed deps → deps.dev license → only the copyleft/unknown ones. */
export async function scanLicenses(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<LicenseFinding[]> {
  const findings: LicenseFinding[] = [];
  const changes = extractDependencyChanges(req.files ?? []).slice(
    0,
    MAX_LICENSE_LOOKUPS,
  );
  for (const change of changes) {
    const system = SYSTEM[change.ecosystem];
    if (!system) continue;
    const licenses = await fetchLicenses(
      system,
      change.package,
      change.to,
      fetchImpl,
      options,
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
