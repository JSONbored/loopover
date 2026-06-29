// Render structured findings into the public-safe prompt block the engine splices into the review. Kept separate
// so each analyzer's rendering is one function and the brief stays deterministic + cap-bounded.
import type { BriefFindings } from "./types.js";

const CODE_SPAN_UNSAFE = /[`\u0000-\u001f\u007f]/g;

const CODE_SPAN_REPLACEMENTS: Record<string, string> = {
  "`": "\u02cb",
  "\n": "\u2424",
  "\r": "\u240d",
  "\t": "\u2409",
};

function safeCodeSpan(value: string): string {
  return `\`${value.replace(
    CODE_SPAN_UNSAFE,
    (char) => CODE_SPAN_REPLACEMENTS[char] ?? "\ufffd",
  )}\``;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

function promptText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/([*_{}[\]()#+.!|-])/g, "\\$1");
}

function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

function bytesLabel(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
  return `${value} B`;
}

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
      const fix = cve.fixedIn
        ? ` — fixed in ${safeCodeSpan(cve.fixedIn)}`
        : "";
      lines.push(
        `- ${safeCodeSpan(`${dep.package}@${dep.to}`)} (${dep.ecosystem}): **${cve.severity}** ${safeCodeSpan(cve.id)} — ${promptText(cve.summary)}${fix}`,
      );
    }
  }

  const lockfileDrift = findings.lockfileDrift ?? [];
  if (lockfileDrift.length) {
    lines.push("### Vulnerable lockfile-only dependency drift (OSV.dev)");
    const flat = lockfileDrift
      .flatMap((dep) => dep.cves.map((cve) => ({ dep, cve })))
      .sort(
        (a, b) =>
          (SEVERITY_RANK[a.cve.severity] ?? 4) -
          (SEVERITY_RANK[b.cve.severity] ?? 4),
      );
    for (const { dep, cve } of flat) {
      const from = dep.from ? ` from ${safeCodeSpan(dep.from)}` : "";
      const fix = cve.fixedIn
        ? ` — fixed in ${safeCodeSpan(cve.fixedIn)}`
        : "";
      lines.push(
        `- ${safeCodeSpan(`${dep.file}:${dep.line}`)} resolves transitive ${safeCodeSpan(`${dep.package}@${dep.to}`)} (${dep.ecosystem})${from}: **${cve.severity}** ${safeCodeSpan(cve.id)} — ${promptText(cve.summary)}${fix}`,
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
        `- ${safeCodeSpan(`${secret.file}:${secret.line}`)} — ${secret.kind} (${secret.confidence} confidence)`,
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
        `- \`${promptText(dep.package)}@${promptText(dep.version)}\` runs ${promptText(dep.hooks.join("/"))} on install${when}`,
      );
    }
  }

  const heavyDependencies = findings.heavyDependency ?? [];
  if (heavyDependencies.length) {
    lines.push(
      "### Heavy dependencies used trivially (consider native code or a small helper)",
    );
    for (const dep of heavyDependencies) {
      const locations = dep.usageLocations
        .map((location) => safeCodeSpan(`${location.file}:${location.line}`))
        .join(", ");
      const dependencyCount =
        dep.dependencyCount === null
          ? "unknown deps"
          : `${dep.dependencyCount} deps`;
      const sizes = `install ${bytesLabel(dep.installSizeBytes)}, bundle ${bytesLabel(dep.bundleSizeBytes)}, gzip ${bytesLabel(dep.gzipSizeBytes)}`;
      lines.push(
        `- ${safeCodeSpan(`${dep.package}@${dep.version}`)} (${dep.ecosystem}): used ${dep.usageCount} time${dep.usageCount === 1 ? "" : "s"} at ${locations}; ${sizes}, ${dependencyCount}`,
      );
    }
  }

  const actionPins = findings.actionPin ?? [];
  if (actionPins.length) {
    lines.push("### Unpinned GitHub Actions (pin to a commit SHA)");
    for (const pin of actionPins) {
      lines.push(
        `- ${safeCodeSpan(`${pin.file}:${pin.line}`)} — ${safeCodeSpan(`${pin.action}@${pin.ref}`)} is a mutable ref; pin to a full commit SHA`,
      );
    }
  }

  const eol = findings.eol ?? [];
  if (eol.length) {
    lines.push("### End-of-life runtimes (upgrade before merging)");
    for (const item of eol) {
      const label = item.status === "eol" ? "END-OF-LIFE" : "EOL soon";
      lines.push(
        `- \`${item.file}\` pins ${item.product} ${item.version} — **${label}** (EOL ${item.eol})`,
      );
    }
  }

  const redos = findings.redos ?? [];
  if (redos.length) {
    lines.push(
      "### ReDoS-prone regex (catastrophic backtracking — DoS on attacker-controlled input)",
    );
    for (const item of redos) {
      lines.push(
        `- ${safeCodeSpan(`${item.file}:${item.line}`)} — ${safeCodeSpan(item.pattern)} nests an unbounded quantifier inside an unbounded-quantified group; bound the repetition or rewrite without nesting`,
      );
    }
  }

  const provenance = findings.provenance ?? [];
  if (provenance.length) {
    const noAttest = provenance.filter((f) => f.kind === "no-attestation");
    const binaries = provenance.filter((f) => f.kind === "binary");
    const vendored = provenance.filter((f) => f.kind === "vendored");
    if (noAttest.length) {
      lines.push(
        "### Dependencies without provenance attestation (supply-chain integrity risk)",
      );
      for (const f of noAttest) {
        lines.push(
          `- ${safeCodeSpan(`${f.package!}@${f.version!}`)} (${f.ecosystem!}): no published SLSA/sigstore attestation — package was not built through a verifiable CI pipeline`,
        );
      }
    }
    if (binaries.length) {
      lines.push("### Binary files committed (no reviewable source)");
      for (const f of binaries) {
        lines.push(
          `- ${safeCodeSpan(f.file!)} — binary artifact without source documentation`,
        );
      }
    }
    if (vendored.length) {
      lines.push(
        "### Vendored or minified code committed (audit source before merging)",
      );
      for (const f of vendored) {
        lines.push(
          `- ${safeCodeSpan(f.file!)} — vendored or minified code without upstream source reference`,
        );
      }
    }
  }

  const codeownersViolations = findings.codeowners ?? [];
  if (codeownersViolations.length) {
    const allOwners = new Set(codeownersViolations.flatMap((f) => f.owners));
    const blastRadius = allOwners.size;
    lines.push(
      `### CODEOWNERS violations — ${blastRadius} ownership domain${blastRadius === 1 ? "" : "s"} affected`,
    );
    for (const item of codeownersViolations) {
      const ownerList = item.owners.map((o) => safeCodeSpan(o)).join(", ");
      lines.push(`- ${safeCodeSpan(item.file)} — owned by ${ownerList}`);
    }
  }

  const secretLogs = findings.secretLog ?? [];
  if (secretLogs.length) {
    lines.push(
      "### Secrets / PII reaching a log or stdout sink (redact before merging)",
    );
    for (const item of secretLogs) {
      const what =
        item.category === "secret"
          ? "a secret/credential"
          : item.category === "pii"
            ? "PII"
            : "a full request/session object";
      lines.push(
        `- ${safeCodeSpan(`${item.file}:${item.line}`)} — ${safeCodeSpan(item.sink)} writes ${what} to a log/stdout sink; redact or remove`,
      );
    }
  }

  const assets = findings.assetWeight ?? [];
  if (assets.length) {
    lines.push(
      "### Heavy binary assets (optimize, or move to a CDN / Git LFS)",
    );
    for (const item of assets) {
      const detail =
        item.status === "added"
          ? `adds ${formatBytes(item.bytes)}`
          : `grows +${formatBytes(item.deltaBytes)} to ${formatBytes(item.bytes)}`;
      lines.push(`- ${safeCodeSpan(item.path)} ${detail}`);
    }
  }

  const typosquats = findings.typosquat ?? [];
  if (typosquats.length) {
    lines.push(
      "### Typosquat / dependency-confusion risks (verify the package name before merging)",
    );
    for (const item of typosquats) {
      const detail =
        item.kind === "typosquat"
          ? `${item.reason} — likely typosquat of ${safeCodeSpan(item.similarTo ?? "")}`
          : item.reason;
      lines.push(
        `- ${safeCodeSpan(`${item.package}@${item.version}`)} (${item.ecosystem}): ${detail}`,
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
