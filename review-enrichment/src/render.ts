// Render structured findings into the public-safe prompt block the engine splices into the review. Kept separate
// so each analyzer's rendering is one function and the brief stays deterministic + cap-bounded.
import type { BriefFindings } from "./types.js";
import { getAnalyzerDescriptor } from "./analyzers/registry.js";
import type { AnalyzerName } from "./analyzers/types.js";
import {
  bytesLabel,
  formatBytes,
  promptText,
  RENDER_HELPERS,
  safeCodeSpan,
  SEVERITY_RANK,
} from "./render-helpers.js";

function renderDescriptorSection(name: AnalyzerName, result: unknown): string[] {
  if (!result) return [];
  const renderer = getAnalyzerDescriptor(name)?.render as
    | ((value: never, helpers: typeof RENDER_HELPERS) => string[])
    | undefined;
  return renderer ? renderer(result as never, RENDER_HELPERS) : [];
}

/** Build the `promptSection` (verbatim splice) + a one-line `systemSuffix` from the findings. Empty when nothing found. */
export function renderBrief(
  findings: BriefFindings,
  maxChars = 6000,
): { promptSection: string; systemSuffix: string } {
  const lines: string[] = [];

  lines.push(...renderDescriptorSection("dependency", findings.dependency));

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

  lines.push(...renderDescriptorSection("secret", findings.secret));

  const licenses = findings.license ?? [];
  if (licenses.length) {
    lines.push("### Dependency licenses (verify compatibility)");
    for (const lic of licenses) {
      // `lic.licenses` is the package's DECLARED license text, passed through verbatim from deps.dev (npm et al.
      // don't validate it), so it can carry backticks/newlines. Escape it — and the package@version — through the
      // same helper every sibling section uses, so a hostile license string can't break out of the code span and
      // inject its own lines into the shared brief (which is spliced into the reviewer's prompt).
      lines.push(
        `- ${safeCodeSpan(`${lic.package}@${lic.version}`)} (${lic.ecosystem}): ${safeCodeSpan(lic.licenses.join("/") || "none")} — **${lic.classification}**`,
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
      // item.file (a diff path) and item.product/item.version (parsed from the pinned file's own contents) are
      // attacker-controlled, and this brief is spliced into the reviewer's prompt. Carry them in code spans via
      // safeCodeSpan (the actionPin sibling above does the same) so a backtick/control char can't break out — it
      // escapes only backticks/control chars, leaving version punctuation like `.`/`-` intact. item.eol is a
      // trusted endoflife.date value rendered in prose, so it stays as-is.
      lines.push(
        `- ${safeCodeSpan(item.file)} pins ${safeCodeSpan(`${item.product} ${item.version}`)} — **${label}** (EOL ${item.eol})`,
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

  const commitSignatures = findings.commitSignature ?? [];
  if (commitSignatures.length) {
    lines.push(
      "### Head-commit signature / author provenance (verify before merging)",
    );
    for (const item of commitSignatures) {
      const status = item.verified
        ? "signature **verified**"
        : "signature **unverified**";
      const flags: string[] = [];
      if (item.authorMismatch)
        flags.push("commit author and committer logins differ");
      if (item.newCommitter)
        flags.push(
          "author has no verified history in a repo that otherwise carries verified commits",
        );
      const who = item.authorLogin
        ? ` by ${safeCodeSpan(item.authorLogin)}`
        : "";
      const detail = flags.length ? ` — ${flags.join("; ")}` : "";
      lines.push(
        `- head commit${who}: ${status} (${safeCodeSpan(item.reason)})${detail}`,
      );
    }
  }

  const iacMisconfigs = findings.iacMisconfig ?? [];
  if (iacMisconfigs.length) {
    const explain = (
      kind: (typeof iacMisconfigs)[number]["kind"],
    ): string => {
      switch (kind) {
        case "wildcard-cors-credentials":
          return "allows wildcard CORS together with credentials; browsers can send authenticated cross-origin requests";
        case "open-ingress":
          return "opens ingress to `0.0.0.0/0`; verify the service is not world-accessible";
        case "public-bucket":
          return "makes object storage public; verify this bucket is intended for anonymous access";
        case "insecure-cookie":
          return "sets `SameSite=None` without `Secure=true`; browsers can send the cookie cross-site over insecure transport";
        case "tls-verification-disabled":
          return "disables TLS certificate verification; this permits man-in-the-middle interception";
        case "prod-debug":
          return "enables debug mode in production configuration; this can expose internals or sensitive data";
        case "hardcoded-service-url":
          return "hardcodes a service URL in config; prefer environment-specific injection or secrets-managed config";
        case "privileged-container":
          return "runs the container in privileged mode, granting near-unrestricted host device and kernel access";
        case "privilege-escalation":
          return "sets `allowPrivilegeEscalation: true`; the process can gain more privileges than its parent";
        case "host-pid-namespace":
          return "shares the host PID namespace; the container can see and signal processes on the host";
        case "host-ipc-namespace":
          return "shares the host IPC namespace; the container can reach host shared-memory segments";
        case "run-as-root":
          return "sets `runAsNonRoot: false`, permitting the container to run as the root user";
        case "run-as-root-uid":
          return "runs the container as UID 0 (root); prefer a dedicated non-root user";
        case "writable-root-filesystem":
          return "sets `readOnlyRootFilesystem: false`; a writable root filesystem eases tampering and persistence";
        case "unmasked-proc-mount":
          return "sets `procMount: Unmasked`, exposing masked `/proc` paths to the container";
        case "unencrypted-storage":
          return "disables storage encryption at rest; verify the stored data does not require encryption";
        case "publicly-accessible-database":
          return "marks the database instance as publicly accessible from the internet";
        case "imdsv1-allowed":
          return "allows IMDSv1 (`http_tokens: optional`); prefer IMDSv2 to mitigate SSRF credential theft";
        case "world-writable-permissions":
          return "grants world-writable `0777` permissions; restrict to the least access the workload needs";
        case "docker-add-remote-url":
          return "uses `ADD` with a remote URL; prefer `COPY` or a verified download so the fetched content stays auditable";
        case "docker-image-latest-tag":
          return "pins a base image to the mutable `:latest` tag; pin a specific version or digest for reproducible, reviewable builds";
        case "docker-root-user":
          return "runs the image as `root` (`USER root`/`USER 0`); switch to a dedicated non-root user";
        case "remote-shell-pipe":
          return "pipes a remote download straight into a shell (`curl … | sh`); this runs unreviewed remote code at build time";
        case "insecure-download-flag":
          return "disables download or TLS certificate verification with an insecure build flag; this permits man-in-the-middle tampering";
        case "ssh-port-exposed":
          return "exposes SSH port 22 from the image; containers should not ship an SSH daemon";
        case "npm-unsafe-perm":
          return "runs npm with `--unsafe-perm`, executing package lifecycle scripts as root";
        case "sudo-in-build":
          return "invokes `sudo` in a build layer; run the build step as the needed user instead of elevating";
        case "hardcoded-build-secret":
          return "hardcodes a credential-shaped value into an image layer via `ENV`/`ARG`; build secrets persist in the image history";
        case "insecure-pip-index":
          return "points a package installer at a plaintext-HTTP index; dependency downloads can be intercepted";
        case "db-ssl-disabled":
          return "disables TLS on the database connection (`sslmode=disable`); traffic and credentials travel in plaintext";
        case "git-ssl-no-verify":
          return "sets `GIT_SSL_NO_VERIFY`, so Git skips TLS certificate verification for remote operations";
        case "ssh-host-key-check-off":
          return "sets `StrictHostKeyChecking no`, so SSH accepts an unknown host key and permits man-in-the-middle";
        case "verify-ssl-off":
          return "disables TLS certificate verification (`verify_ssl: false`); this permits man-in-the-middle interception";
        case "validate-certs-off":
          return "sets `validate_certs: no`, so the client accepts any TLS certificate (Ansible/HTTP module)";
        case "tls-skip-verify":
          return "sets `tls_skip_verify`/`insecure_skip_verify: true`, so TLS certificate verification is skipped";
        case "trust-all-server-certs":
          return "sets `TrustServerCertificate=true`, so the client trusts any database server certificate";
        case "seccomp-unconfined-runtime":
          return "runs the container with `seccomp:unconfined`, disabling the syscall filter";
        case "apparmor-unconfined":
          return "runs the container with `apparmor:unconfined`, disabling the AppArmor profile";
        case "userns-host":
          return "sets `userns_mode: host`, disabling user-namespace remapping so container UID 0 is host root";
        case "ipc-host":
          return "sets `ipc: host`, sharing the host IPC namespace (host shared memory is reachable from the container)";
        case "cap-add-all":
          return "adds `ALL` Linux capabilities to the container (`cap_add: [ALL]`), which is close to privileged";
        case "no-new-privileges-off":
          return "disables the `no-new-privileges` protection, allowing setuid binaries to escalate privileges";
        case "docker-socket-mount":
          return "mounts the host Docker socket (`/var/run/docker.sock`) into the container — this grants host-level control";
        case "hsts-disabled":
          return "disables HSTS with `Strict-Transport-Security` `max-age=0`, so browsers stop enforcing HTTPS for the host";
        case "referrer-policy-leak":
          return "sets `Referrer-Policy: unsafe-url`, leaking the full URL (path and query) to cross-origin destinations";
        case "cookie-not-httponly":
          return "sets `httpOnly: false` on a cookie, exposing it to JavaScript so an XSS can read it";
      }
    };

    lines.push("### IaC / config misconfigurations (review before merging)");
    for (const item of iacMisconfigs) {
      lines.push(
        `- ${safeCodeSpan(`${item.file}:${item.line}`)} — ${explain(item.kind)}`,
      );
    }
  }

  const nativeBuilds = findings.nativeBuild ?? [];
  if (nativeBuilds.length) {
    lines.push(
      "### Native-build / install-cost dependencies (CI cold-start + cross-platform build cost)",
    );
    for (const item of nativeBuilds) {
      lines.push(
        `- ${safeCodeSpan(`${item.package}@${item.version}`)} (${item.ecosystem}): ${item.reason}`,
      );
    }
  }

  const history = findings.history ?? [];
  for (const item of history) {
    const entries: string[] = [];
    if (item.author) {
      const a = item.author;
      let record: string;
      if (
        a.firstTimeContributor === null ||
        a.priorMergedInRepo === null ||
        a.priorClosedInRepo === null
      ) {
        record = "prior PR history unavailable";
      } else if (a.firstTimeContributor) {
        record = "first-time contributor to this repo";
      } else {
        record = `${a.priorMergedInRepo} merged / ${a.priorClosedInRepo} closed prior PRs here`;
      }
      const age =
        a.accountAgeDays === null
          ? "account age unknown"
          : `account ${a.accountAgeDays}d old`;
      entries.push(`- Author: ${record}; ${age}`);
    }
    for (const pr of item.similarPastPrs) {
      const paths = pr.overlapPaths.length
        ? pr.overlapPaths.map((p) => safeCodeSpan(p)).join(", ")
        : "unknown paths";
      entries.push(
        `- This area was previously changed in #${pr.number} (${pr.outcome}): ${promptText(pr.title)} — overlaps ${paths}`,
      );
    }
    if (item.linkedIssueAlignment) {
      const al = item.linkedIssueAlignment;
      entries.push(
        `- Linked issue #${al.issue} coverage: **${al.diffCovers}** — ${promptText(al.statedRequirement)}`,
      );
    }
    if (entries.length) {
      lines.push("### Author & change-area history (public GitHub record)");
      if (item.partial)
        lines.push("- _(partial — some history could not be retrieved)_");
      lines.push(...entries);
    }
  }

  const docDrift = findings.docCommentDrift ?? [];
  if (docDrift.length) {
    lines.push(
      "### Doc-comment drift (JSDoc @param names the signature no longer declares — update the doc)",
    );
    for (const item of docDrift) {
      const params = item.staleParams.map((name) => safeCodeSpan(name)).join(", ");
      lines.push(
        `- ${safeCodeSpan(`${item.file}:${item.line}`)} ${safeCodeSpan(item.symbol)} documents ${params} — no longer a parameter`,
      );
    }
  }

  const duplication = findings.duplication ?? [];
  if (duplication.length) {
    lines.push(
      "### Near-verbatim duplicated code (prefer importing the existing implementation)",
    );
    for (const item of duplication) {
      lines.push(
        `- ${safeCodeSpan(`${item.file}:${item.line}`)} duplicates ${safeCodeSpan(`${item.sourceFile}:${item.sourceLine}`)} (~${item.lines} lines)`,
      );
    }
  }

  const churnHotspots = findings.churnHotspot ?? [];
  if (churnHotspots.length) {
    lines.push(
      "### Churn hotspots (high commit + fix/revert density — historically fragile, scrutinize)",
    );
    for (const item of churnHotspots) {
      const pct = item.commitCount ? Math.round((item.fixCount / item.commitCount) * 100) : 0;
      const count = `${item.commitCount}${item.capped ? "+" : ""}`;
      lines.push(
        `- ${safeCodeSpan(item.file)} — ${count} commits in ${item.windowDays}d, ${item.fixCount} fix/revert (${pct}%)`,
      );
    }
  }

  lines.push(...renderDescriptorSection("blameLink", findings.blameLink));
  lines.push(...renderDescriptorSection("approvalIntegrity", findings.approvalIntegrity));
  lines.push(...renderDescriptorSection("ciCheckSignals", findings.ciCheckSignals));
  lines.push(...renderDescriptorSection("undocumentedExport", findings.undocumentedExport));
  lines.push(...renderDescriptorSection("staleBranch", findings.staleBranch));
  lines.push(...renderDescriptorSection("commitHygiene", findings.commitHygiene));
  lines.push(...renderDescriptorSection("pendingReviewRequests", findings.pendingReviewRequests));
  lines.push(...renderDescriptorSection("testRatio", findings.testRatio));
  lines.push(...renderDescriptorSection("migrationSafety", findings.migrationSafety));
  lines.push(...renderDescriptorSection("looseRange", findings.looseRange));
  lines.push(...renderDescriptorSection("terminology", findings.terminology));
  lines.push(...renderDescriptorSection("todoMarker", findings.todoMarker));
  lines.push(...renderDescriptorSection("magicNumber", findings.magicNumber));
  lines.push(...renderDescriptorSection("conflictMarker", findings.conflictMarker));
  lines.push(...renderDescriptorSection("commitLint", findings.commitLint));

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
