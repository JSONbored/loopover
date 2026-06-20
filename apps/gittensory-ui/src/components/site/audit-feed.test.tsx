import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import {
  buildSkippedPrAuditPath,
  formatSkipReason,
  normalizeSinceInput,
  normalizeSkippedPrAuditExport,
  pullRequestHref,
} from "@/components/site/audit-feed-model";
import { AuditFeed } from "@/components/site/audit-feed";

const SAMPLE: {
  generatedAt: string;
  limit: number;
  hasMore: boolean;
  filters: { repoFullName: null; reason: null; since: null };
  items: Array<{
    repoFullName: string;
    pullNumber: number;
    reason: string;
    timestamp: string;
    remediation: string;
  }>;
} = {
  generatedAt: "2026-05-28T00:00:05.000Z",
  limit: 50,
  hasMore: false,
  filters: { repoFullName: null, reason: null, since: null },
  items: [
    {
      repoFullName: "repo-owner/owned-repo",
      pullNumber: 6,
      reason: "surface_off",
      timestamp: "2026-05-28T00:00:04.000Z",
      remediation: "Enable a PR public surface in repository settings.",
    },
  ],
};

describe("audit feed helpers", () => {
  it("builds query paths for skipped PR audit filters", () => {
    expect(buildSkippedPrAuditPath({ limit: 25 })).toBe("/v1/app/skipped-pr-audit?limit=25");
    expect(
      buildSkippedPrAuditPath({
        limit: 50,
        repoFullName: "repo-owner/owned-repo",
        reason: "bot_author",
        since: "2026-05-28T00:00:00.000Z",
      }),
    ).toBe(
      "/v1/app/skipped-pr-audit?limit=50&repoFullName=repo-owner%2Fowned-repo&reason=bot_author&since=2026-05-28T00%3A00%3A00.000Z",
    );
  });

  it("formats skip reasons and pull request links", () => {
    expect(formatSkipReason("surface_off")).toBe("Surface off");
    expect(formatSkipReason("legacy_skip_reason")).toBe("legacy skip reason");
    expect(pullRequestHref("repo-owner/owned-repo", 6)).toBe(
      "https://github.com/repo-owner/owned-repo/pull/6",
    );
  });

  it("normalizes since input without throwing on invalid dates", () => {
    expect(normalizeSinceInput("")).toBe("");
    expect(normalizeSinceInput("   ")).toBe("");
    expect(normalizeSinceInput("not-a-date")).toBe("");
    expect(normalizeSinceInput("2026-05-28T00:00:00.000Z")).toBe("2026-05-28T00:00:00.000Z");
    expect(() => normalizeSinceInput("definitely-not-a-date")).not.toThrow();
  });

  it("normalizes skipped-pr audit exports and rejects malformed payloads", () => {
    expect(normalizeSkippedPrAuditExport(SAMPLE)).toEqual(SAMPLE);
    expect(normalizeSkippedPrAuditExport({ ...SAMPLE, items: [] })).toMatchObject({ items: [] });
    expect(normalizeSkippedPrAuditExport(null)).toBeNull();
    expect(normalizeSkippedPrAuditExport({ generatedAt: "2026-05-28T00:00:05.000Z" })).toBeNull();
    expect(
      normalizeSkippedPrAuditExport({
        ...SAMPLE,
        items: [
          {
            repoFullName: "x/y",
            pullNumber: 1,
            reason: "bot_author",
            timestamp: "t",
            remediation: "r",
          },
          null,
          "bad",
        ],
      }),
    ).toMatchObject({ items: [{ repoFullName: "x/y", pullNumber: 1 }] });
  });
});

describe("AuditFeed", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE });
  });

  it("renders populated audit rows from the skipped-pr-audit API", async () => {
    render(<AuditFeed />);
    expect(await screen.findByText("repo-owner/owned-repo")).toBeTruthy();
    expect(screen.getByText("Enable a PR public surface in repository settings.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /#6/i }).getAttribute("href")).toBe(
      "https://github.com/repo-owner/owned-repo/pull/6",
    );
    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.test/v1/app/skipped-pr-audit?limit=50",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("shows an empty state when the audit export has no items", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ...SAMPLE, items: [] } });
    render(<AuditFeed />);
    expect(await screen.findByText("No skipped PR events")).toBeTruthy();
  });

  it("shows an error state when the audit request fails", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "insufficient_role" });
    render(<AuditFeed />);
    expect(await screen.findByText("Couldn't load skip audit")).toBeTruthy();
    expect(screen.getByText("insufficient_role")).toBeTruthy();
  });

  it("applies repository filters to subsequent audit requests", async () => {
    render(<AuditFeed />);
    await screen.findByText("repo-owner/owned-repo");
    apiFetch.mockClear();
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE });

    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "repo-owner/owned-repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining("repoFullName=repo-owner%2Fowned-repo"),
        expect.any(Object),
      ),
    );
  });

  it("ignores invalid since values when applying filters", async () => {
    render(<AuditFeed />);
    await screen.findByText("repo-owner/owned-repo");
    apiFetch.mockClear();
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE });

    fireEvent.change(screen.getByLabelText(/^since$/i), {
      target: { value: "definitely-not-a-date" },
    });
    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "repo-owner/owned-repo" },
    });
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /apply filters/i })),
    ).not.toThrow();

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining("repoFullName=repo-owner%2Fowned-repo"),
        expect.any(Object),
      ),
    );
    expect(apiFetch.mock.calls.some(([url]) => String(url).includes("since="))).toBe(false);
  });

  it("shows a role error when the feed is disabled", async () => {
    render(<AuditFeed enabled={false} />);
    expect(await screen.findByText("Couldn't load skip audit")).toBeTruthy();
    expect(screen.getByText("This audit feed is unavailable for your current role.")).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("loads more rows until the maximum page size", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ...SAMPLE, hasMore: true } });
    render(<AuditFeed />);
    await screen.findByText("repo-owner/owned-repo");
    apiFetch.mockClear();
    apiFetch.mockResolvedValue({ ok: true, data: { ...SAMPLE, hasMore: true, limit: 100 } });

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/skipped-pr-audit?limit=100",
        expect.any(Object),
      ),
    );

    expect(screen.getByText(/maximum page size \(100\)/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("shows an error state when the audit response is malformed", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { generatedAt: "2026-05-28T00:00:05.000Z" } });
    render(<AuditFeed />);
    expect(await screen.findByText("Couldn't load skip audit")).toBeTruthy();
    expect(
      screen.getByText("The skipped PR audit endpoint returned an unexpected response."),
    ).toBeTruthy();
  });
});
