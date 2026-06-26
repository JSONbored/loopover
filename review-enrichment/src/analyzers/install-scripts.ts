// Install-script & lifecycle-hook auditor (brainstorm #2). For each npm dependency a PR adds/upgrades, fetches the
// registry packument and flags ones that ship preinstall/install/postinstall scripts — the #1 npm-malware execution
// vector (a script runs on `npm install`, before any code review of the package's source). The shipped CVE scan
// misses this entirely; the no-checkout reviewer can't fetch a packument. Public-safe output: package@version + the
// hook names + publish date (NOT the script body, to keep the brief compact and non-executable).
import type { EnrichRequest, InstallScriptFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

/** Analyzer entrypoint: changed npm deps → registry packument → only the versions that run install scripts. */
export async function scanInstallScripts(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallScriptFinding[]> {
  const findings: InstallScriptFinding[] = [];
  for (const change of extractDependencyChanges(req.files ?? [])) {
    if (change.ecosystem !== "npm") continue;
    // Scoped packages (@scope/name) encode only the slash in the registry path; the @ stays literal.
    const response = await fetchImpl(
      `https://registry.npmjs.org/${change.package.replace("/", "%2F")}`,
    );
    if (!response.ok) continue;
    const data = (await response.json()) as {
      versions?: Record<string, { scripts?: Record<string, string> }>;
      time?: Record<string, string>;
    };
    const scripts = data.versions?.[change.to]?.scripts ?? {};
    const hooks = INSTALL_HOOKS.filter(
      (hook) => typeof scripts[hook] === "string",
    );
    if (hooks.length) {
      findings.push({
        package: change.package,
        version: change.to,
        hooks,
        publishedAt: data.time?.[change.to] ?? null,
      });
    }
  }
  return findings;
}
