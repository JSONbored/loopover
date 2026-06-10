import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GITTENSORY_REPO_FOCUS_MANIFEST_YAML,
  GITTENSOR_SELF_REPO_DEFAULT,
  resolveGittensorySelfRepoFullName,
} from "../../src/config/gittensory-repo-focus-manifest";
import { createTestEnv } from "../helpers/d1";
import {
  buildFocusManifestGuidance,
  compileFocusManifestPolicy,
  isFocusManifestPublicSafe,
  parseFocusManifestContent,
} from "../../src/signals/focus-manifest";
import { loadRepoFocusManifest, MANIFEST_FILE_CANDIDATES } from "../../src/signals/focus-manifest-loader";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|payout|reward estimate|raw trust score|public score estimate|private reviewability|farming/i;

describe("resolveGittensorySelfRepoFullName", () => {
  it("defaults to the Gittensory repo when drift issue repo is unset or invalid", () => {
    expect(resolveGittensorySelfRepoFullName({})).toBe(GITTENSOR_SELF_REPO_DEFAULT);
    expect(resolveGittensorySelfRepoFullName({ GITTENSORY_DRIFT_ISSUE_REPO: "invalid" })).toBe(GITTENSOR_SELF_REPO_DEFAULT);
    expect(resolveGittensorySelfRepoFullName({ GITTENSORY_DRIFT_ISSUE_REPO: "  " })).toBe(GITTENSOR_SELF_REPO_DEFAULT);
  });

  it("returns a configured owner/repo drift target when present", () => {
    expect(resolveGittensorySelfRepoFullName({ GITTENSORY_DRIFT_ISSUE_REPO: "acme/widget" })).toBe("acme/widget");
    expect(resolveGittensorySelfRepoFullName({ GITTENSORY_DRIFT_ISSUE_REPO: "  org/repo  " })).toBe("org/repo");
  });
});

describe("Gittensory repo focus manifest", () => {
  it("keeps bundled YAML aligned with the committed .gittensory.yml file", () => {
    const onDisk = readFileSync(resolve(process.cwd(), ".gittensory.yml"), "utf8").trim();
    expect(GITTENSORY_REPO_FOCUS_MANIFEST_YAML.trim()).toBe(onDisk);
  });

  it("valid manifest fixture parses and compiles policy", () => {
    const manifest = parseFocusManifestContent(GITTENSORY_REPO_FOCUS_MANIFEST_YAML, "repo_file");
    expect(manifest.present).toBe(true);
    expect(manifest.wantedPaths).toContain("src/");
    expect(manifest.wantedPaths).toContain("apps/gittensory-ui/");
    expect(manifest.blockedPaths).toContain("site/");
    expect(manifest.blockedPaths).not.toContain("apps/gittensory-ui/");
    expect(manifest.issueDiscoveryPolicy).toBe("discouraged");

    const policy = compileFocusManifestPolicy(manifest);
    const directPrLane = policy.publicSafe.contributionLanes.find((lane) => lane.id === "direct-pr");
    expect(directPrLane?.preference).toBe("preferred");
    expect(policy.publicSafe.issueDiscoveryPolicy).toBe("discouraged");
    expect(policy.authenticated.maintainerContext.length).toBeGreaterThan(0);
    expect(JSON.stringify(policy)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("malformed manifest fixture warns safely", () => {
    const manifest = parseFocusManifestContent("wantedPaths: [\n  - src/\n", "repo_file");
    expect(manifest.present).toBe(false);
    expect(manifest.warnings.join(" ")).toMatch(/not valid YAML/i);
  });

  it("blocked path fixture flags retired static-site surfaces", () => {
    const manifest = parseFocusManifestContent(GITTENSORY_REPO_FOCUS_MANIFEST_YAML, "repo_file");
    const guidance = buildFocusManifestGuidance({
      manifest,
      changedPaths: ["site/docs/index.html"],
    });
    expect(guidance.findings.some((finding) => finding.code === "manifest_blocked_path")).toBe(true);
    expect(guidance.summary).toMatch(/blocked area/i);
  });

  it("focused control-panel UI changes align with wanted paths", () => {
    const manifest = parseFocusManifestContent(GITTENSORY_REPO_FOCUS_MANIFEST_YAML, "repo_file");
    const guidance = buildFocusManifestGuidance({
      manifest,
      changedPaths: ["apps/gittensory-ui/src/routes/app.operator.tsx"],
    });
    expect(guidance.findings.some((finding) => finding.code === "manifest_preferred_path")).toBe(true);
    expect(guidance.findings.some((finding) => finding.code === "manifest_blocked_path")).toBe(false);
  });

  it("recommendation influence prefers in-scope backend and UI paths separately from blocked surfaces", () => {
    const manifest = parseFocusManifestContent(GITTENSORY_REPO_FOCUS_MANIFEST_YAML, "repo_file");
    const backend = buildFocusManifestGuidance({ manifest, changedPaths: ["src/api/routes.ts"] });
    const controlPanel = buildFocusManifestGuidance({ manifest, changedPaths: ["apps/gittensory-ui/src/app.tsx"] });
    const retiredSite = buildFocusManifestGuidance({ manifest, changedPaths: ["site/index.html"] });
    expect(backend.findings.some((finding) => finding.code === "manifest_preferred_path")).toBe(true);
    expect(controlPanel.findings.some((finding) => finding.code === "manifest_preferred_path")).toBe(true);
    expect(retiredSite.findings.some((finding) => finding.code === "manifest_blocked_path")).toBe(true);
  });

  it("public/private boundary regression keeps maintainer notes out of public guidance", () => {
    const manifest = parseFocusManifestContent(GITTENSORY_REPO_FOCUS_MANIFEST_YAML, "repo_file");
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["src/x.ts"] });
    for (const step of guidance.publicNextSteps) {
      expect(isFocusManifestPublicSafe(step)).toBe(true);
      expect(step).not.toMatch(/maintainer notes are private/i);
    }
    expect(manifest.maintainerNotes.join(" ")).toMatch(/private triage/i);
  });

  it("loads bundled manifest for the Gittensory repo when fetch is unavailable", async () => {
    const env = createTestEnv({ GITTENSORY_DRIFT_ISSUE_REPO: "JSONbored/gittensory" });
    const manifest = await loadRepoFocusManifest(env, "JSONbored/gittensory", { fetcher: async () => null });
    expect(manifest.present).toBe(true);
    expect(manifest.wantedPaths).toContain("packages/");
    expect(manifest.wantedPaths).toContain("apps/gittensory-ui/");
    expect(manifest.blockedPaths).toContain("site/");
  });

  it("flags lovable-only and CNAME paths as blocked surfaces", () => {
    const manifest = parseFocusManifestContent(GITTENSORY_REPO_FOCUS_MANIFEST_YAML, "repo_file");
    for (const changedPath of ["CNAME", "vendor/lovable/widget.ts"]) {
      const guidance = buildFocusManifestGuidance({ manifest, changedPaths: [changedPath] });
      expect(guidance.findings.some((finding) => finding.code === "manifest_blocked_path")).toBe(true);
    }
  });

  it("prefers YAML manifest file candidates before JSON", () => {
    expect(MANIFEST_FILE_CANDIDATES[0]).toBe(".gittensory.yml");
    expect(MANIFEST_FILE_CANDIDATES).toContain(".gittensory.json");
  });
});
