import { describe, expect, it, vi } from "vitest";
import { buildSecretScanDiff, maybeAddSecretLeakFinding } from "../../src/queue/processors";
import {
  addedLinesForSecretScan,
  enrichSecretScanFilesWithPatchFallback,
  incompletePatchLessSecretScanFinding,
  SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES,
  markEligiblePatchLessFilesIncomplete,
  patchlessSecretScanInternals,
} from "../../src/queue/patchless-secret-scan";
import type { FileFetcher } from "../../src/review/review-grounding";
import { secretLeakFinding } from "../../src/review/safety";
import type { Advisory, AdvisoryFinding } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function advisory(findings: AdvisoryFinding[] = []): Advisory {
  return {
    id: "adv-1",
    targetType: "pull_request",
    targetKey: "acme/widgets#7",
    repoFullName: "acme/widgets",
    pullNumber: 7,
    headSha: "sha7",
    conclusion: "neutral",
    severity: "info",
    title: "Gittensory advisory available",
    summary: "ok",
    findings,
    generatedAt: "2026-06-20T00:00:00.000Z",
  };
}
describe("enrichSecretScanFilesWithPatchFallback", () => {
  const fakeToken = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  it("addedLinesForSecretScan returns only multiset-added lines", () => {
    expect(addedLinesForSecretScan("a\nb\n", "a\nb\nc\n")).toEqual(["c"]);
    expect(addedLinesForSecretScan("a\na\n", "a\na\na\n")).toEqual(["a"]);
  });

  it("returns an empty list unchanged when there are no patch-less files to enrich", async () => {
    const fetcher: FileFetcher = {
      async getFileContent() {
        throw new Error("fetch should not run for an empty file list");
      },
    };
    const enriched = await enrichSecretScanFilesWithPatchFallback([], {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched).toEqual([]);
  });

  it("synthesizes a scannable patch for a patch-less added file", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "secrets.env" && ref === "head-sha") return `const token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(secretLeakFinding(buildSecretScanDiff(enriched))?.code).toBe("secret_leak");
  });

  it("synthesizes only added lines for a patch-less modified file", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path !== "src/config.ts") return null;
        if (ref === "base-sha") return "const existing = 1;\n";
        if (ref === "head-sha") return `const existing = 1;\nconst token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(secretLeakFinding(buildSecretScanDiff(enriched))?.code).toBe("secret_leak");
  });

  it("leaves a patch-less modified file unscannable when baseSha is unknown", async () => {
    const fetcher: FileFetcher = {
      async getFileContent() {
        return `const token = "${fakeToken}";\n`;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(secretLeakFinding(buildSecretScanDiff(enriched))).toBeNull();
  });

  it("returns files unchanged when headSha is absent", async () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const fetcher: FileFetcher = {
      async getFileContent() {
        throw new Error("fetch should not run without headSha");
      },
    };
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, { headSha: null, fetcher });
    expect(enriched).toBe(files);
  });

  it("returns files unchanged when headSha is blank whitespace", async () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const fetcher: FileFetcher = {
      async getFileContent() {
        throw new Error("fetch should not run without a trimmed headSha");
      },
    };
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, { headSha: "   ", fetcher });
    expect(enriched).toBe(files);
  });

  it("skips files that already have an inline patch", async () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: "@@\n+const ok = 1;" },
      },
    ];
    const fetcher: FileFetcher = {
      async getFileContent() {
        throw new Error("fetch should not run when patch is present");
      },
    };
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBe("@@\n+const ok = 1;");
  });

  it("skips removed files and leaves them header-only", async () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "removed",
        additions: 0,
        deletions: 1,
        changes: 1,
        payload: {},
      },
    ];
    const fetcher: FileFetcher = {
      async getFileContent() {
        return `const token = "${fakeToken}";\n`;
      },
    };
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
    expect(buildSecretScanDiff(enriched)).toBe("### secrets.env (removed) +0/-1");
  });

  it("leaves a file unchanged when the fetcher cannot read head content", async () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const fetcher: FileFetcher = {
      async getFileContent() {
        return null;
      },
    };
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
    expect(incompletePatchLessSecretScanFinding(enriched)?.detail).toContain("secrets.env");
  });

  it("does not mark a patch-less added file incomplete when head content is an empty string", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "empty.txt" && ref === "head-sha") return "";
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "empty.txt",
        status: "added",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.secretScanIncomplete).toBeUndefined();
    expect(incompletePatchLessSecretScanFinding(enriched)).toBeNull();
  });

  it("scans a patch-less modified file when base content is an empty string", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path !== "src/config.ts") return null;
        if (ref === "base-sha") return "";
        if (ref === "head-sha") return `const token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.secretScanIncomplete).toBeUndefined();
    expect(secretLeakFinding(buildSecretScanDiff(enriched))?.code).toBe("secret_leak");
  });

  it("returns null from incompletePatchLessSecretScanFinding when every file scanned completely", () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "ok.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: "@@\n+const ok = 1;" },
      },
    ];
    expect(incompletePatchLessSecretScanFinding(files)).toBeNull();
  });

  it("marks a renamed file incomplete when base content exceeds the scan cap", async () => {
    const oversized = "x".repeat(512_001);
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "old-secrets.env" && ref === "base-sha") return oversized;
        if (path === "secrets.env" && ref === "head-sha") return "const existing = 1;\n";
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        previousFilename: "old-secrets.env",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
    expect(incompletePatchLessSecretScanFinding(enriched)?.detail).toContain("secrets.env");
  });

  it("marks a renamed file incomplete when head content exceeds the scan cap", async () => {
    const oversized = "x".repeat(512_001);
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "secrets.env" && ref === "head-sha") return oversized;
        if (path === "old-secrets.env" && ref === "base-sha") return "const existing = 1;\n";
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        previousFilename: "old-secrets.env",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
  });

  it("reports every incomplete patch-less path in the finding detail", async () => {
    const fetcher: FileFetcher = {
      async getFileContent() {
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "a.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "b.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    const finding = incompletePatchLessSecretScanFinding(enriched);
    expect(finding?.title).toContain("(2)");
    expect(finding?.detail).toContain("a.env");
    expect(finding?.detail).toContain("b.env");
  });

  it("caps the incomplete-path detail list while the title keeps the full count", () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      repoFullName: "acme/widgets",
      pullNumber: 7,
      path: `file-${index}.env`,
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: { secretScanIncomplete: true },
    }));
    const finding = incompletePatchLessSecretScanFinding(files);
    expect(finding?.title).toContain("(7)");
    expect(finding?.detail).toContain("file-0.env");
    expect(finding?.detail).toContain("file-4.env");
    expect(finding?.detail).not.toContain("file-5.env");
    expect(finding?.detail).toContain("and 2 more");
  });

  it("marks a renamed file incomplete when base content cannot be fetched", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "old-secrets.env" && ref === "base-sha") return null;
        if (path === "secrets.env" && ref === "head-sha") return "const existing = 1;\n";
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        previousFilename: "old-secrets.env",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
  });

  it("marks a modified file incomplete when base content exceeds the scan cap", async () => {
    const oversized = "x".repeat(512_001);
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path !== "src/config.ts") return null;
        if (ref === "base-sha") return oversized;
        if (ref === "head-sha") return "const existing = 1;\n";
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
  });

  it("enriches a patch-less file whose status defaults to modified when baseSha is known", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path !== "src/config.ts") return null;
        if (ref === "base-sha") return "const existing = 1;\n";
        if (ref === "head-sha") return `const existing = 1;\nconst token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: null,
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ] as unknown as Parameters<typeof enrichSecretScanFilesWithPatchFallback>[0];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(secretLeakFinding(buildSecretScanDiff(enriched))?.code).toBe("secret_leak");
  });

  it("processes more patch-less files than the concurrency limit without dropping siblings", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (ref !== "head-sha") return null;
        if (path.endsWith(".env")) return `const token = "${fakeToken}";\n`;
        return "const ok = 1;\n";
      },
    };
    const files = Array.from({ length: 6 }, (_, index) => ({
      repoFullName: "acme/widgets",
      pullNumber: 7,
      path: index === 0 ? "secrets.env" : `src/file${index}.ts`,
      status: "added" as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    }));
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched).toHaveLength(6);
    expect(secretLeakFinding(buildSecretScanDiff(enriched))?.code).toBe("secret_leak");
  });

  it("fails closed without fetching when patch-less files exceed the aggregate fetch budget", async () => {
    let fetches = 0;
    const fetcher: FileFetcher = {
      async getFileContent() {
        fetches += 1;
        return "const ok = 1;\n";
      },
    };
    const files = Array.from({ length: SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES + 1 }, (_, index) => ({
      repoFullName: "acme/widgets",
      pullNumber: 7,
      path: `bulk-${index}.env`,
      status: "added" as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    }));
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(fetches).toBe(0);
    expect(enriched.every((file) => file.payload.secretScanIncomplete === true)).toBe(true);
    expect(incompletePatchLessSecretScanFinding(enriched)?.title).toContain(
      `(${SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES + 1})`,
    );
  });

  it("allows patch-less files at the aggregate fetch budget", async () => {
    let fetches = 0;
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        fetches += 1;
        if (ref === "head-sha") return `const ok = "${path}";`;
        return null;
      },
    };
    const files = Array.from({ length: SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES }, (_, index) => ({
      repoFullName: "acme/widgets",
      pullNumber: 7,
      path: `bulk-${index}.env`,
      status: "added" as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    }));
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(fetches).toBe(SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES);
    expect(enriched.every((file) => typeof file.payload.patch === "string")).toBe(true);
    expect(incompletePatchLessSecretScanFinding(enriched)).toBeNull();
  });

  it("synthesizes a scannable patch for a patch-less renamed file with a newly added secret", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "old-secrets.env" && ref === "base-sha") return "const existing = 1;\n";
        if (path === "secrets.env" && ref === "head-sha") return `const existing = 1;\nconst token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        previousFilename: "old-secrets.env",
        status: "renamed",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(secretLeakFinding(buildSecretScanDiff(enriched))?.code).toBe("secret_leak");
  });

  it("does not flag a pure rename when the credential already existed in base", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "old-secrets.env" && ref === "base-sha") return `const token = "${fakeToken}";\n`;
        if (path === "secrets.env" && ref === "head-sha") return `const token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        previousFilename: "old-secrets.env",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
    expect(secretLeakFinding(buildSecretScanDiff(enriched))).toBeNull();
  });

  it("leaves a renamed file unchanged when previous path or baseSha is unknown", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "secrets.env" && ref === "head-sha") return `const token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
  });

  it("does not inject a synthetic patch when modified head matches base (no added lines)", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path !== "src/config.ts") return null;
        if (ref === "base-sha" || ref === "head-sha") return "const existing = 1;\n";
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 0,
        deletions: 0,
        changes: 0,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
  });

  it("marks a modified file incomplete when base content cannot be fetched", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path !== "src/config.ts") return null;
        if (ref === "base-sha") return null;
        if (ref === "head-sha") return `const token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      baseSha: "base-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
    expect(secretLeakFinding(buildSecretScanDiff(enriched))).toBeNull();
  });

  it("scans patch-less content at the exact 512KB cap without marking incomplete", async () => {
    const atCap = "x".repeat(512_000);
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "large.env" && ref === "head-sha") return atCap;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "large.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.secretScanIncomplete).toBeUndefined();
    expect(enriched[0]?.payload.patch).toContain("+");
  });

  it("enriches a single patch-less file with bounded concurrency", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "only.env" && ref === "head-sha") return "const ok = 1;";
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "only.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBe("+const ok = 1;");
  });

  it("marks a patch-less file incomplete when fetched content exceeds the scan cap", async () => {
    const oversized = "x".repeat(512_001);
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "secrets.env" && ref === "head-sha") return oversized;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
    expect(incompletePatchLessSecretScanFinding(enriched)?.code).toBe("secret_leak");
  });

  it("marks one patch-less file incomplete when its fetch rejects without blocking siblings", async () => {
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "secrets.env" && ref === "head-sha") throw new Error("transient contents api");
        if (path === "other.env" && ref === "head-sha") return `const token = "${fakeToken}";\n`;
        return null;
      },
    };
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "other.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const enriched = await enrichSecretScanFilesWithPatchFallback(files, {
      headSha: "head-sha",
      fetcher,
    });
    expect(enriched[0]?.payload.patch).toBeUndefined();
    expect(enriched[0]?.payload.secretScanIncomplete).toBe(true);
    expect(enriched[1]?.payload.patch).toContain(fakeToken);
    expect(secretLeakFinding(buildSecretScanDiff(enriched))?.code).toBe("secret_leak");
  });
});

describe("patchlessSecretScanInternals", () => {
  const {
    hasPatchLessSecretScanCandidates,
    markEligiblePatchLessFilesIncomplete,
    shouldAttemptPatchLessSecretScan,
    syntheticSecretScanPatch,
    isOverSecretScanContentLimit,
    markPatchLessSecretScanIncomplete,
    patchLessSecretScanFetchCost,
    patchLessSecretScanFetchCostExceedsBudget,
  } = patchlessSecretScanInternals;

  it("hasPatchLessSecretScanCandidates ignores inline patches and ineligible statuses", () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "inline.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: "@@\n+const ok = 1;" },
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "unchanged.env",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "added.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    expect(hasPatchLessSecretScanCandidates(files, null)).toBe(true);
    expect(
      hasPatchLessSecretScanCandidates(
        [
          {
            repoFullName: "acme/widgets",
            pullNumber: 7,
            path: "default-status.ts",
            additions: 1,
            deletions: 0,
            changes: 1,
            payload: {},
          },
        ] as Parameters<typeof hasPatchLessSecretScanCandidates>[0],
        "base-sha",
      ),
    ).toBe(true);
    expect(
      hasPatchLessSecretScanCandidates(
        [
          {
            repoFullName: "acme/widgets",
            pullNumber: 7,
            path: "inline.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            changes: 1,
            payload: { patch: "+x" },
          },
        ],
        null,
      ),
    ).toBe(false);
  });

  it("shouldAttemptPatchLessSecretScan only allows added files without baseSha", () => {
    expect(shouldAttemptPatchLessSecretScan({}, "added", null)).toBe(true);
    expect(shouldAttemptPatchLessSecretScan({}, "modified", "base-sha")).toBe(true);
    expect(shouldAttemptPatchLessSecretScan({}, "modified", null)).toBe(false);
    expect(shouldAttemptPatchLessSecretScan({}, "modified", "   ")).toBe(false);
    expect(shouldAttemptPatchLessSecretScan({}, "removed", "base-sha")).toBe(false);
    expect(shouldAttemptPatchLessSecretScan({}, "copied", "base-sha")).toBe(false);
    expect(shouldAttemptPatchLessSecretScan({}, "added", "base-sha")).toBe(true);
    expect(
      shouldAttemptPatchLessSecretScan({ previousFilename: "old.env" }, "renamed", "base-sha"),
    ).toBe(true);
    expect(shouldAttemptPatchLessSecretScan({ previousFilename: "old.env" }, "renamed", null)).toBe(
      false,
    );
    expect(
      shouldAttemptPatchLessSecretScan({ previousFilename: "old.env" }, "renamed", "   "),
    ).toBe(false);
    expect(
      shouldAttemptPatchLessSecretScan({ previousFilename: "   " }, "renamed", "base-sha"),
    ).toBe(false);
    expect(shouldAttemptPatchLessSecretScan({}, "renamed", "base-sha")).toBe(false);
  });

  it("covers helper boundaries for synthetic patches and content limits", () => {
    expect(syntheticSecretScanPatch(["a", "b"])).toBe("+a\n+b");
    expect(isOverSecretScanContentLimit("x".repeat(512_000))).toBe(false);
    expect(isOverSecretScanContentLimit("x".repeat(512_001))).toBe(true);
    const incomplete = markPatchLessSecretScanIncomplete({
      path: "secrets.env",
    } as Parameters<typeof markPatchLessSecretScanIncomplete>[0]);
    expect(incomplete.payload?.secretScanIncomplete).toBe(true);
  });

  it("counts aggregate fetch budget by patch-less status and eligibility", () => {
    const added = {
      repoFullName: "acme/widgets",
      pullNumber: 7,
      path: "added.env",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: {},
    };
    const modified = { ...added, path: "modified.env", status: "modified" };
    const inline = { ...added, path: "inline.env", payload: { patch: "+ok" } };
    const removed = { ...added, path: "removed.env", status: "removed" };
    expect(patchLessSecretScanFetchCost(added, null)).toBe(1);
    expect(patchLessSecretScanFetchCost(modified, "base-sha")).toBe(2);
    expect(patchLessSecretScanFetchCost(modified, null)).toBe(0);
    expect(patchLessSecretScanFetchCost(inline, null)).toBe(0);
    expect(patchLessSecretScanFetchCost(removed, "base-sha")).toBe(0);
    expect(patchLessSecretScanFetchCostExceedsBudget([added], null)).toBe(false);
    expect(
      patchLessSecretScanFetchCostExceedsBudget(
        Array.from({ length: SECRET_SCAN_PATCH_FALLBACK_MAX_FETCHES + 1 }, () => added),
        null,
      ),
    ).toBe(true);
  });

  it("addedLinesForSecretScan handles identical content and multiset decrements", () => {
    expect(addedLinesForSecretScan("", "")).toEqual([]);
    expect(addedLinesForSecretScan("a\nb\n", "a\nb\n")).toEqual([]);
    expect(addedLinesForSecretScan("a\na\n", "a\na\nb\n")).toEqual(["b"]);
  });

  it("markEligiblePatchLessFilesIncomplete preserves inline patches and ineligible patch-less files", () => {
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "inline.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: "@@\n+const ok = 1;" },
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "unchanged.env",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "removed.env",
        status: "removed",
        additions: 0,
        deletions: 1,
        changes: 1,
        payload: {},
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "added.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "default-status.env",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ] as Parameters<typeof markEligiblePatchLessFilesIncomplete>[0];
    const marked = markEligiblePatchLessFilesIncomplete(files, null);
    expect(marked[0]?.payload.patch).toBe("@@\n+const ok = 1;");
    expect(marked[0]?.payload.secretScanIncomplete).toBeUndefined();
    expect(marked[1]?.payload.secretScanIncomplete).toBeUndefined();
    expect(marked[2]?.payload.secretScanIncomplete).toBeUndefined();
    expect(marked[3]?.payload.secretScanIncomplete).toBe(true);
    expect(incompletePatchLessSecretScanFinding(marked)?.detail).toContain("added.env");
    const markedWithBase = markEligiblePatchLessFilesIncomplete([files[4]!], "base-sha");
    expect(markedWithBase[0]?.payload.secretScanIncomplete).toBe(true);
  });
});

describe("maybeAddSecretLeakFinding patch-less fallback wiring", () => {
  const fakeToken = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  it("uses head/base SHAs to recover patch-less file content before scanning", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "secrets.env" && ref === "head-sha") return `const token = "${fakeToken}";\n`;
        return null;
      },
    };
    const spy = vi.spyOn(groundingWire, "makeGithubFileFetcher").mockResolvedValue(fetcher);
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    spy.mockRestore();
    expect(adv.findings.map((f) => f.code)).toContain("secret_leak");
  });

  it("falls back to inline patches when patch-less enrichment rejects", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: `@@\n+const token = "${fakeToken}";` },
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const fetcher: FileFetcher = {
      async getFileContent() {
        throw new Error("transient contents api");
      },
    };
    const spy = vi.spyOn(groundingWire, "makeGithubFileFetcher").mockResolvedValue(fetcher);
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    spy.mockRestore();
    expect(adv.findings.map((f) => f.code)).toContain("secret_leak");
  });

  it("blocks patch-less files when makeGithubFileFetcher rejects", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const spy = vi
      .spyOn(groundingWire, "makeGithubFileFetcher")
      .mockRejectedValue(new Error("installation token unavailable"));
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    spy.mockRestore();
    expect(adv.findings.some((f) => f.title.includes("could not be fully scanned"))).toBe(true);
    expect(adv.findings.map((f) => f.code)).toContain("secret_leak");
  });

  it("still scans inline patches when makeGithubFileFetcher rejects", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: `@@\n+const token = "${fakeToken}";` },
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const spy = vi
      .spyOn(groundingWire, "makeGithubFileFetcher")
      .mockRejectedValue(new Error("installation token unavailable"));
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    spy.mockRestore();
    expect(adv.findings.map((f) => f.code)).toContain("secret_leak");
  });

  it("does not block modified patch-less files when fetcher rejects and baseSha is unknown", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const spy = vi
      .spyOn(groundingWire, "makeGithubFileFetcher")
      .mockRejectedValue(new Error("installation token unavailable"));
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
    });
    spy.mockRestore();
    expect(adv.findings.some((f) => f.title.includes("could not be fully scanned"))).toBe(false);
    expect(adv.findings).toHaveLength(0);
  });

  it("skips patch-less fetch wiring when headSha is empty at the gate", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const spy = vi.spyOn(groundingWire, "makeGithubFileFetcher");
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "",
    });
    spy.mockRestore();
    expect(spy).not.toHaveBeenCalled();
    expect(adv.findings).toHaveLength(0);
  });

  it("skips makeGithubFileFetcher when every file already has an inline patch", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "src/app.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: { patch: "@@\n+const ok = 1;" },
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const spy = vi.spyOn(groundingWire, "makeGithubFileFetcher");
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    spy.mockRestore();
    expect(spy).not.toHaveBeenCalled();
    expect(adv.findings).toHaveLength(0);
  });

  it("blocks when patch-less enrichment cannot fully scan an oversized file", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const oversized = "x".repeat(512_001);
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const fetcher: FileFetcher = {
      async getFileContent(path, ref) {
        if (path === "secrets.env" && ref === "head-sha") return oversized;
        return null;
      },
    };
    const spy = vi.spyOn(groundingWire, "makeGithubFileFetcher").mockResolvedValue(fetcher);
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    spy.mockRestore();
    expect(adv.findings.some((f) => f.title.includes("could not be fully scanned"))).toBe(true);
  });

  it("blocks when patch-less enrichment cannot fetch head content for an added file", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const files = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 7,
        path: "secrets.env",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        payload: {},
      },
    ];
    const groundingWire = await import("../../src/review/grounding-wire");
    const fetcher: FileFetcher = {
      async getFileContent() {
        return null;
      },
    };
    const spy = vi.spyOn(groundingWire, "makeGithubFileFetcher").mockResolvedValue(fetcher);
    await maybeAddSecretLeakFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      files,
      installationId: 1,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
    spy.mockRestore();
    expect(adv.findings.some((f) => f.title.includes("could not be fully scanned"))).toBe(true);
  });
});
