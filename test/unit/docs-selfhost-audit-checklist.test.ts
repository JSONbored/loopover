import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicSafeText } from "../../src/signals/redaction";
import {
  LOOSE_DOCS_ROWS,
  SELFHOST_DOCS_PAGES,
  SELFHOST_DOCS_VALIDATION_COMMANDS,
  SELFHOST_SOURCE_OF_TRUTH_ROWS,
} from "../../apps/loopover-ui/src/lib/selfhost-docs-audit";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROUTES_DIR = resolve(REPO_ROOT, "apps/loopover-ui/src/routes");
const CONTENT_DIR = resolve(REPO_ROOT, "apps/loopover-ui/content/docs");
// SPIKE (#6037): these two pages' prose now lives in the migrated content/docs/*.mdx files, not
// the route .tsx, which only orchestrates the fumadocs loader + client-loader -- point the drift
// guard at the actual content source. docs.index.tsx (below, for the docs-hub link check) is the
// nav page, not migrated, so it stays pointed at the .tsx.
const AUDIT_PAGE = resolve(REPO_ROOT, "apps/loopover-ui/content/docs/self-hosting-docs-audit.mdx");
const MAINTAINER_INDEX = resolve(REPO_ROOT, "apps/loopover-ui/content/docs/maintainer-self-hosting.mdx");
const PACKAGE_JSON = resolve(REPO_ROOT, "package.json");

function repoPath(relativePath: string): string {
  return resolve(REPO_ROOT, relativePath);
}

describe("self-host docs accuracy audit (#1829)", () => {
  const auditSource = readFileSync(AUDIT_PAGE, "utf8");
  const maintainerSource = readFileSync(MAINTAINER_INDEX, "utf8");
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { scripts: Record<string, string> };

  it("manifest lists every self-host docs content file on disk (pages are content/docs/*.mdx since the #8182 dynamic route)", () => {
    for (const page of SELFHOST_DOCS_PAGES) {
      expect(existsSync(resolve(CONTENT_DIR, page.contentFile)), page.contentFile).toBe(true);
    }
  });

  it("every runtime source in the checklist exists in the repo", () => {
    const missing: string[] = [];
    for (const row of SELFHOST_SOURCE_OF_TRUTH_ROWS) {
      for (const source of row.runtimeSources) {
        const path = repoPath(source);
        if (!existsSync(path)) missing.push(source);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every drift-guard test file referenced by the checklist exists", () => {
    const guards = [
      ...new Set(
        SELFHOST_SOURCE_OF_TRUTH_ROWS.map((row) => row.driftGuard).filter((g): g is string => Boolean(g)),
      ),
    ];
    expect(guards.length).toBeGreaterThan(5);
    for (const guard of guards) {
      expect(existsSync(repoPath(`test/unit/${guard}`)), guard).toBe(true);
    }
  });

  it("every validation command in the checklist is a real npm script", () => {
    for (const command of SELFHOST_DOCS_VALIDATION_COMMANDS) {
      const match = /^npm run (\S+)/.exec(command);
      expect(match, command).not.toBeNull();
      expect(packageJson.scripts[match![1]!], command).toBeDefined();
    }
  });

  it("maintainer index and docs hub link to the audit page", () => {
    expect(maintainerSource).toContain("/docs/self-hosting-docs-audit");
    expect(readFileSync(resolve(ROUTES_DIR, "docs.index.tsx"), "utf8")).toContain(
      "/docs/self-hosting-docs-audit",
    );
  });

  it("documents Sentry as opt-in with an operator-owned DSN", () => {
    expect(auditSource).toMatch(/opt-in and off by default/i);
    expect(auditSource).toContain("SENTRY_DSN");
    expect(auditSource).toContain("SENTRY_DSN_FILE");
  });

  it("records the loose-docs consolidation plan with canonical website links", () => {
    const manifestSource = readFileSync(
      resolve(REPO_ROOT, "apps/loopover-ui/src/lib/selfhost-docs-audit.ts"),
      "utf8",
    );
    for (const row of LOOSE_DOCS_ROWS) {
      expect(existsSync(repoPath(row.path)), row.path).toBe(true);
      expect(manifestSource).toContain(row.path);
      expect(auditSource).toContain("LOOSE_DOCS_ROWS");
    }
    const linkOnly = LOOSE_DOCS_ROWS.filter((row) => row.websiteDocsPath);
    expect(linkOnly.length).toBeGreaterThan(0);
    for (const row of linkOnly) {
      expect(manifestSource).toContain(row.websiteDocsPath!);
    }
  });

  it("excludes REES analyzer auto-metadata from this audit scope", () => {
    const normalized = auditSource.replace(/\s+/g, " ");
    expect(normalized).toMatch(/REES analyzer metadata generation is tracked separately/i);
  });

  it("is public-safe end-to-end per the canonical sanitizer", () => {
    expect(isPublicSafeText(auditSource)).toBe(true);
  });
});
