import { describe, expect, it, vi } from "vitest";
import {
  auditPullRequestAutoReviewSkip,
  resolveAutoReviewSkipForPullRequest,
  resolveReviewManifestForAiReview,
} from "../../src/queue/processors";
import { parseFocusManifest, resolvePullRequestAutoReviewSkipReason } from "../../src/signals/focus-manifest";
import * as focusManifestLoader from "../../src/signals/focus-manifest-loader";
import * as repositoriesModule from "../../src/db/repositories";

describe("review.auto_review wiring (#1954)", () => {
  it("resolvePullRequestAutoReviewSkipReason: forceAiReview bypasses every filter", () => {
    const manifest = parseFocusManifest({ review: { auto_review: { skip_drafts: true, auto_pause_after_reviewed_commits: 1 } } });
    expect(
      resolvePullRequestAutoReviewSkipReason({
        forceAiReview: true,
        manifest,
        isDraft: true,
        author: "dependabot[bot]",
        title: "WIP: bump",
        baseRef: "develop",
        reviewedCommitCount: 99,
      }),
    ).toBeNull();
  });

  it("resolvePullRequestAutoReviewSkipReason: skips when a configured label is present", () => {
    const manifest = parseFocusManifest({ review: { auto_review: { skip_labels: ["do-not-review"] } } });
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "alice",
        title: "feat: thing",
        labels: ["Do-Not-Review"],
        baseRef: "main",
      }),
    ).toBe("review skipped (label)");
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "alice",
        title: "feat: thing",
        labels: ["feature"],
        baseRef: "main",
      }),
    ).toBeNull();
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "alice",
        title: "feat: thing",
        baseRef: "main",
      }),
    ).toBeNull();
  });

  it("resolvePullRequestAutoReviewSkipReason: skips docs-only PRs when configured", () => {
    const manifest = parseFocusManifest({ review: { auto_review: { skip_docs_only: true } } });
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "alice",
        title: "docs: update guide",
        changedPaths: ["README.md", "docs/guide.md"],
        baseRef: "main",
      }),
    ).toBe("review skipped (docs only)");
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "alice",
        title: "docs: update guide",
        changedPaths: ["README.md", "src/a.ts"],
        baseRef: "main",
      }),
    ).toBeNull();
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "alice",
        title: "docs: update guide",
        changedPaths: [],
        baseRef: "main",
      }),
    ).toBeNull();
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "alice",
        title: "docs: update guide",
        baseRef: "main",
      }),
    ).toBeNull();
  });

  it("resolvePullRequestAutoReviewSkipReason: skips oversized PRs when size caps are configured", () => {
    const linesManifest = parseFocusManifest({ review: { auto_review: { max_added_lines: 10 } } });
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest: linesManifest,
        isDraft: false,
        author: "alice",
        title: "feat: big change",
        addedLineCount: 11,
        changedFileCount: 1,
        baseRef: "main",
      }),
    ).toBe("review skipped (too large)");
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest: linesManifest,
        isDraft: false,
        author: "alice",
        title: "feat: big change",
        addedLineCount: 10,
        changedFileCount: 1,
        baseRef: "main",
      }),
    ).toBeNull();

    const filesManifest = parseFocusManifest({ review: { auto_review: { max_files: 2 } } });
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest: filesManifest,
        isDraft: false,
        author: "alice",
        title: "feat: wide change",
        addedLineCount: 1,
        changedFileCount: 3,
        baseRef: "main",
      }),
    ).toBe("review skipped (too large)");
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest: filesManifest,
        isDraft: false,
        author: "alice",
        title: "feat: wide change",
        addedLineCount: 1,
        changedFileCount: 2,
        baseRef: "main",
      }),
    ).toBeNull();
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest: filesManifest,
        isDraft: false,
        author: "alice",
        title: "feat: wide change",
        baseRef: "main",
      }),
    ).toBeNull();
  });

  it("resolvePullRequestAutoReviewSkipReason: matches the documented *[bot] author glob", () => {
    const manifest = parseFocusManifest({ review: { auto_review: { ignore_authors: ["*[bot]"] } } });
    expect(
      resolvePullRequestAutoReviewSkipReason({
        manifest,
        isDraft: false,
        author: "dependabot[bot]",
        title: "chore: bump deps",
        baseRef: "main",
      }),
    ).toBe("review skipped (ignored author)");
  });

  it("auditPullRequestAutoReviewSkip records the skip reason and is fail-safe on audit errors", async () => {
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockResolvedValue(undefined);
    await auditPullRequestAutoReviewSkip({} as Env, {
      actor: "dependabot[bot]",
      repoFullName: "acme/widgets",
      pullNumber: 7,
      deliveryId: "delivery-1",
      headSha: "abc123",
      skipReason: "review skipped (ignored author)",
    });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "github_app.ai_review_auto_review_skipped",
        detail: "review skipped (ignored author)",
        targetKey: "acme/widgets#7",
        metadata: expect.objectContaining({
          summary: "The author matches review.auto_review.ignore_authors, so AI review is skipped.",
        }),
      }),
    );

    auditSpy.mockRejectedValueOnce(new Error("audit DB down"));
    await expect(
      auditPullRequestAutoReviewSkip({} as Env, {
        actor: "bot",
        repoFullName: "acme/widgets",
        pullNumber: 8,
        deliveryId: "delivery-2",
        headSha: null,
        skipReason: "review skipped (draft)",
      }),
    ).resolves.toBeUndefined();
    auditSpy.mockRestore();
  });

  it("resolveAutoReviewSkipForPullRequest skips manifest load when author is blacklisted or frozen", async () => {
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest");
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: true,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 1, title: "feat", baseRef: "main", isDraft: false },
        author: "alice",
        deliveryId: "d1",
        headSha: "sha1",
      }),
    ).resolves.toEqual({ skipReason: null, reviewManifest: null });
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: true,
        repoFullName: "acme/widgets",
        pr: { number: 2, title: "feat", baseRef: "main", isDraft: false },
        author: "alice",
        deliveryId: "d2",
        headSha: "sha2",
      }),
    ).resolves.toEqual({ skipReason: null, reviewManifest: null });
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  it("resolveAutoReviewSkipForPullRequest loads manifest, audits skip reasons, and fail-opens on load errors", async () => {
    const manifest = parseFocusManifest({ review: { auto_review: { skip_drafts: true } } });
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest").mockResolvedValue(manifest);
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockResolvedValue(undefined);

    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 3, title: "WIP", baseRef: "main", isDraft: true, labels: [] },
        author: "alice",
        deliveryId: "d3",
        headSha: "sha3",
      }),
    ).resolves.toEqual({ skipReason: "review skipped (draft)", reviewManifest: manifest });
    expect(auditSpy).toHaveBeenCalled();

    const labelManifest = parseFocusManifest({ review: { auto_review: { skip_labels: ["do-not-review"] } } });
    loadSpy.mockResolvedValueOnce(labelManifest);
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 6, title: "feat", baseRef: "main", isDraft: false, labels: ["Do-Not-Review"] },
        author: "alice",
        deliveryId: "d6",
        headSha: "sha6",
      }),
    ).resolves.toEqual({ skipReason: "review skipped (label)", reviewManifest: labelManifest });

    const docsManifest = parseFocusManifest({ review: { auto_review: { skip_docs_only: true } } });
    loadSpy.mockResolvedValueOnce(docsManifest);
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 8, title: "docs", baseRef: "main", isDraft: false, labels: [] },
        author: "alice",
        deliveryId: "d8",
        headSha: "sha8",
        changedPaths: ["README.md"],
      }),
    ).resolves.toEqual({ skipReason: "review skipped (docs only)", reviewManifest: docsManifest });

    const sizeManifest = parseFocusManifest({ review: { auto_review: { max_added_lines: 1 } } });
    loadSpy.mockResolvedValueOnce(sizeManifest);
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 9, title: "feat", baseRef: "main", isDraft: false, labels: [] },
        author: "alice",
        deliveryId: "d9",
        headSha: "sha9",
        changedPaths: ["src/a.ts"],
        addedLineCount: 2,
        changedFileCount: 1,
      }),
    ).resolves.toEqual({ skipReason: "review skipped (too large)", reviewManifest: sizeManifest });

    loadSpy.mockRejectedValueOnce(new Error("manifest unavailable"));
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 4, title: "ok", baseRef: "main", isDraft: false },
        author: "alice",
        deliveryId: "d4",
        headSha: "sha4",
      }),
    ).resolves.toEqual({ skipReason: null, reviewManifest: null });

    loadSpy.mockResolvedValueOnce(labelManifest);
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 7, title: "feat", baseRef: "main", isDraft: false },
        author: "alice",
        deliveryId: "d7",
        headSha: "sha7",
      }),
    ).resolves.toEqual({ skipReason: null, reviewManifest: labelManifest });

    loadSpy.mockRestore();
  });

  it("resolveAutoReviewSkipForPullRequest pauses when published review count reaches the commit threshold (#2042)", async () => {
    const manifest = parseFocusManifest({ review: { auto_review: { auto_pause_after_reviewed_commits: 2 } } });
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest").mockResolvedValue(manifest);
    const countSpy = vi.spyOn(repositoriesModule, "countPublishedAiReviewHeads").mockResolvedValue(2);
    const auditSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockResolvedValue(undefined);

    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 5, title: "feat", baseRef: "main", isDraft: false },
        author: "alice",
        deliveryId: "d5",
        headSha: "sha5",
      }),
    ).resolves.toEqual({ skipReason: "review paused (commit threshold)", reviewManifest: manifest });
    expect(countSpy).toHaveBeenCalledWith(expect.anything(), "acme/widgets", 5);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ detail: "review paused (commit threshold)" }),
    );

    countSpy.mockResolvedValueOnce(1);
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 6, title: "feat", baseRef: "main", isDraft: false },
        author: "alice",
        deliveryId: "d6",
        headSha: "sha6",
      }),
    ).resolves.toEqual({ skipReason: null, reviewManifest: manifest });

    countSpy.mockRejectedValueOnce(new Error("DB down"));
    await expect(
      resolveAutoReviewSkipForPullRequest({} as Env, {
        authorBlacklisted: false,
        isFrozenForManualReview: false,
        repoFullName: "acme/widgets",
        pr: { number: 7, title: "feat", baseRef: "main", isDraft: false },
        author: "alice",
        deliveryId: "d7",
        headSha: "sha7",
      }),
    ).resolves.toEqual({ skipReason: null, reviewManifest: manifest });

    loadSpy.mockRestore();
    countSpy.mockRestore();
    auditSpy.mockRestore();
  });

  it("resolveReviewManifestForAiReview reuses cached manifest or loads fail-safely", async () => {
    const manifest = parseFocusManifest({ review: { auto_review: { skip_drafts: true } } });
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest");

    await expect(resolveReviewManifestForAiReview({} as Env, "acme/widgets", manifest)).resolves.toBe(manifest);
    expect(loadSpy).not.toHaveBeenCalled();

    loadSpy.mockResolvedValueOnce(manifest);
    await expect(resolveReviewManifestForAiReview({} as Env, "acme/widgets", null)).resolves.toBe(manifest);

    loadSpy.mockRejectedValueOnce(new Error("manifest unavailable"));
    await expect(resolveReviewManifestForAiReview({} as Env, "acme/widgets", null)).resolves.toBeNull();

    loadSpy.mockRestore();
  });
});
