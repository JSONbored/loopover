import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithQueryClient as render } from "@/lib/test-query-client";
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
  skipReasonTone,
} from "@/components/site/audit-feed-model";
import { AuditFeed } from "@/components/site/audit-feed";

const SAMPLE: {
  generatedAt: string;
  limit: number;
  offset: number;
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
  offset: 0,
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
    expect(buildSkippedPrAuditPath({ limit: 25 })).toBe(
      "/v1/app/skipped-pr-audit?limit=25&offset=0",
    );
    expect(
      buildSkippedPrAuditPath({
        limit: 50,
        offset: 50,
        repoFullName: "repo-owner/owned-repo",
        reason: "bot_author",
        since: "2026-05-28T00:00:00.000Z",
      }),
    ).toBe(
      "/v1/app/skipped-pr-audit?limit=50&offset=50&repoFullName=repo-owner%2Fowned-repo&reason=bot_author&since=2026-05-28T00%3A00%3A00.000Z",
    );
  });

  it("formats skip reasons and pull request links", () => {
    expect(formatSkipReason("surface_off")).toBe("Surface off");
    expect(formatSkipReason("legacy_skip_reason")).toBe("legacy skip reason");
    expect(pullRequestHref("repo-owner/owned-repo", 6)).toBe(
      "https://github.com/repo-owner/owned-repo/pull/6",
    );
  });

  it("maps the enumerated skip reasons to their tones and degrades an unrecognized reason to the neutral info tone, never ready", () => {
    // The four enumerated reasons keep their existing tones.
    expect(skipReasonTone("bot_author")).toBe("info");
    expect(skipReasonTone("not_official_gittensor_miner")).toBe("info");
    expect(skipReasonTone("surface_off")).toBe("warn");
    expect(skipReasonTone("maintainer_author")).toBe("warn");
    expect(skipReasonTone("miner_detection_unavailable")).toBe("degraded");
    expect(skipReasonTone("missing_author")).toBe("degraded");
    // An unrecognized/legacy reason string must degrade to the neutral pill (the
    // contributor-quality-table-model `band: string` convention), not the green "ready" tone.
    expect(skipReasonTone("legacy_skip_reason")).toBe("info");
    expect(skipReasonTone("legacy_skip_reason")).not.toBe("ready");
    expect(skipReasonTone("")).toBe("info");
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
      "https://api.test/v1/app/skipped-pr-audit?limit=50&offset=0",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("renders an unrecognized skip reason as a neutral info pill, not the green ready tone", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...SAMPLE,
        items: [
          {
            repoFullName: "repo-owner/owned-repo",
            pullNumber: 6,
            reason: "legacy_skip_reason",
            timestamp: "2026-05-28T00:00:04.000Z",
            remediation: "Contact support to reclassify this legacy skip.",
          },
        ],
      },
    });
    render(<AuditFeed />);
    const pill = await screen.findByText("legacy skip reason");
    // "info" tone (text-mint), never the "ready" tone (text-success) that implies a healthy state.
    expect(pill.className).toContain("text-mint");
    expect(pill.className).not.toContain("text-success");
  });

  it("wraps the audit table in a keyboard-focusable, labelled scroll region with a caption and column-scoped headers (#794 a11y pattern)", async () => {
    render(<AuditFeed />);
    await screen.findByText("repo-owner/owned-repo");
    const region = screen.getByRole("region", { name: "Skipped PR audit" });
    // A bare overflow-x-auto div is not a tab stop; TableScroll makes it one (WCAG 2.1.1).
    expect(region.tabIndex).toBe(0);
    expect(region.className).toContain("overflow-x-auto");
    const table = screen.getByRole("table", {
      name: "Skipped pull requests with the time, repository, pull request, skip reason, and remediation for each.",
    });
    expect(within(table).getByRole("columnheader", { name: "Time" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Remediation" })).toBeTruthy();
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

  it("appends the next offset page without replacing already-visible rows (#7438)", async () => {
    const firstPage = {
      ...SAMPLE,
      hasMore: true,
      offset: 0,
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
    const secondPage = {
      ...SAMPLE,
      hasMore: false,
      offset: 1,
      items: [
        {
          repoFullName: "repo-owner/owned-repo",
          pullNumber: 5,
          reason: "bot_author",
          timestamp: "2026-05-28T00:00:03.000Z",
          remediation: "Bot authors are excluded from public PR surfaces.",
        },
      ],
    };
    apiFetch.mockResolvedValue({ ok: true, data: firstPage });
    render(<AuditFeed />);
    expect(await screen.findByText("#6")).toBeTruthy();
    apiFetch.mockClear();
    apiFetch.mockResolvedValue({ ok: true, data: secondPage });

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/skipped-pr-audit?limit=50&offset=1",
        expect.any(Object),
      ),
    );

    expect(screen.getByText("#6")).toBeTruthy();
    expect(await screen.findByText("#5")).toBeTruthy();
    expect(screen.getByText("2 event(s)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
    expect(screen.queryByText(/maximum page size/i)).toBeNull();
  });

  it("resets to offset 0 when filters are applied after load-more (#7438)", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...SAMPLE,
        hasMore: true,
        items: [
          {
            repoFullName: "repo-owner/owned-repo",
            pullNumber: 6,
            reason: "surface_off",
            timestamp: "2026-05-28T00:00:04.000Z",
            remediation: "Enable a PR public surface in repository settings.",
          },
        ],
      },
    });
    render(<AuditFeed />);
    await screen.findByText("#6");
    apiFetch.mockClear();
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...SAMPLE,
        hasMore: false,
        offset: 1,
        items: [
          {
            repoFullName: "repo-owner/owned-repo",
            pullNumber: 5,
            reason: "bot_author",
            timestamp: "2026-05-28T00:00:03.000Z",
            remediation: "Bot authors are excluded from public PR surfaces.",
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("#5");

    apiFetch.mockClear();
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE });
    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "repo-owner/owned-repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/skipped-pr-audit?limit=50&offset=0&repoFullName=repo-owner%2Fowned-repo",
        expect.any(Object),
      ),
    );
  });

  it("ignores a loadMore response after filters change mid-flight (#7506)", async () => {
    const firstPage = {
      ...SAMPLE,
      hasMore: true,
      offset: 0,
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
    const filteredPage = {
      ...SAMPLE,
      hasMore: false,
      offset: 0,
      items: [
        {
          repoFullName: "repo-owner/other-repo",
          pullNumber: 9,
          reason: "bot_author",
          timestamp: "2026-05-28T00:00:06.000Z",
          remediation: "Bot authors are excluded from public PR surfaces.",
        },
      ],
    };
    const staleMorePage = {
      ...SAMPLE,
      hasMore: false,
      offset: 1,
      items: [
        {
          repoFullName: "repo-owner/owned-repo",
          pullNumber: 5,
          reason: "bot_author",
          timestamp: "2026-05-28T00:00:03.000Z",
          remediation: "Bot authors are excluded from public PR surfaces.",
        },
      ],
    };

    let resolveMore!: (value: { ok: true; data: typeof staleMorePage }) => void;
    const morePromise = new Promise<{ ok: true; data: typeof staleMorePage }>((resolve) => {
      resolveMore = resolve;
    });

    apiFetch.mockImplementation((url: string) => {
      if (String(url).includes("offset=1")) return morePromise;
      if (String(url).includes("repoFullName=")) {
        return Promise.resolve({ ok: true, data: filteredPage });
      }
      return Promise.resolve({ ok: true, data: firstPage });
    });

    render(<AuditFeed />);
    expect(await screen.findByText("#6")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() =>
      expect(apiFetch.mock.calls.some(([url]) => String(url).includes("offset=1"))).toBe(true),
    );

    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "repo-owner/other-repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));
    expect(await screen.findByText("#9")).toBeTruthy();
    expect(screen.queryByText("#6")).toBeNull();

    resolveMore({ ok: true, data: staleMorePage });
    await waitFor(() => expect(screen.getByText("#9")).toBeTruthy());
    expect(screen.queryByText("#6")).toBeNull();
    expect(screen.queryByText("#5")).toBeNull();
    expect(screen.getByText("1 event(s)")).toBeTruthy();
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
