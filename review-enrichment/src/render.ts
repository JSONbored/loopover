// Render structured findings into the public-safe prompt block the engine splices into the review. Kept separate
// so each analyzer's rendering is one function and the brief stays deterministic + cap-bounded.
import type { BriefFindings } from "./types.js";

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

/** Build the `promptSection` (verbatim splice) + a one-line `systemSuffix` from the findings. Empty when nothing found. */
export function renderBrief(
  findings: BriefFindings,
  maxChars = 6000,
): { promptSection: string; systemSuffix: string } {
  const lines: string[] = [];

  const deps = findings.dependency ?? [];
  if (deps.length) {
    lines.push("### Dependency vulnerabilities (OSV.dev)");
    const flat = deps
      .flatMap((dep) => dep.cves.map((cve) => ({ dep, cve })))
      .sort(
        (a, b) =>
          (SEVERITY_RANK[a.cve.severity] ?? 4) -
          (SEVERITY_RANK[b.cve.severity] ?? 4),
      );
    for (const { dep, cve } of flat) {
      const fix = cve.fixedIn ? ` — fixed in ${cve.fixedIn}` : "";
      lines.push(
        `- \`${dep.package}@${dep.to}\` (${dep.ecosystem}): **${cve.severity}** ${cve.id} — ${cve.summary}${fix}`,
      );
    }
  }

  const secrets = findings.secret ?? [];
  if (secrets.length) {
    lines.push(
      "### Potential leaked secrets (value-redacted — verify + rotate)",
    );
    for (const secret of secrets) {
      lines.push(
        `- \`${secret.file}:${secret.line}\` — ${secret.kind} (${secret.confidence} confidence)`,
      );
    }
  }

  const licenses = findings.license ?? [];
  if (licenses.length) {
    lines.push("### Dependency licenses (verify compatibility)");
    for (const lic of licenses) {
      lines.push(
        `- \`${lic.package}@${lic.version}\` (${lic.ecosystem}): ${lic.licenses.join("/") || "none"} — **${lic.classification}**`,
      );
    }
  }

  const installScripts = findings.installScript ?? [];
  if (installScripts.length) {
    lines.push(
      "### Dependency install scripts (supply-chain risk — review before merging)",
    );
    for (const dep of installScripts) {
      const when = dep.publishedAt
        ? ` (published ${dep.publishedAt.slice(0, 10)})`
        : "";
      lines.push(
        `- \`${dep.package}@${dep.version}\` runs ${dep.hooks.join("/")} on install${when}`,
      );
    }
  }

  const actionPins = findings.actionPin ?? [];
  if (actionPins.length) {
    lines.push("### Unpinned GitHub Actions (pin to a commit SHA)");
    for (const pin of actionPins) {
      lines.push(
        `- \`${pin.file}:${pin.line}\` — \`${pin.action}@${pin.ref}\` is a mutable ref; pin to a full commit SHA`,
      );
    }
  }

  if (!lines.length) return { promptSection: "", systemSuffix: "" };

  const header =
    "## EXTERNAL REVIEW BRIEF (heavy/external analysis the in-prompt reviewer cannot run)";
  let body = `${header}\n${lines.join("\n")}\n`;
  if (body.length > maxChars)
    body = body.slice(0, maxChars) + "\n…(brief truncated)\n";
  const systemSuffix =
    "When the EXTERNAL REVIEW BRIEF lists a CVE for a package+version, treat it as verified ground truth — do not re-derive it.";
  return { promptSection: body, systemSuffix };
}
