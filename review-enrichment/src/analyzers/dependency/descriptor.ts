import type { AnalyzerDescriptor } from "../types.js";
import { scanDependencies } from "../dependency-scan.js";
import { SEVERITY_RANK } from "../../render-helpers.js";

export const dependencyAnalyzer: AnalyzerDescriptor<"dependency"> = {
  name: "dependency",
  title: "Dependency vulnerabilities",
  category: "supply-chain",
  cost: "registry",
  defaultEnabled: true,
  requires: ["files", "public-network"],
  limits: {
    maxManifestFiles: 20,
    maxPatchLinesPerFile: 500,
    maxDependencyQueries: 25,
  },
  docs: {
    summary: "Checks changed direct dependency versions against OSV.dev.",
    looksAt:
      "Added or upgraded dependencies in package.json, requirements.txt, and go.mod diffs.",
    reports:
      "Known CVEs with severity, advisory id, summary, and fixed version when OSV publishes one.",
    network: "Calls OSV.dev. No GitHub token required.",
    notes:
      "Manifest-only by design; use lockfileDrift for transitive lockfile changes.",
  },
  run: (req, { signal }) => scanDependencies(req, fetch, { signal }),
  render: (deps, { safeCodeSpan, promptText }) => {
    const lines: string[] = [];
    if (!deps.length) return lines;
    lines.push("### Dependency vulnerabilities (OSV.dev)");
    const flat = deps
      .flatMap((dep) => dep.cves.map((cve) => ({ dep, cve })))
      .sort(
        (a, b) =>
          (SEVERITY_RANK[a.cve.severity] ?? 4) -
          (SEVERITY_RANK[b.cve.severity] ?? 4),
      );
    for (const { dep, cve } of flat) {
      const fix = cve.fixedIn
        ? ` — fixed in ${safeCodeSpan(cve.fixedIn)}`
        : "";
      lines.push(
        `- ${safeCodeSpan(`${dep.package}@${dep.to}`)} (${dep.ecosystem}): **${cve.severity}** ${safeCodeSpan(cve.id)} — ${promptText(cve.summary)}${fix}`,
      );
    }
    return lines;
  },
};
