import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import {
  buildDeadLetterQueuePath,
  DEAD_LETTER_ERROR_TRUNCATE_LENGTH,
  formatDeadLetterTimestamp,
  normalizeDeadLetterQueuePage,
  truncateErrorMessage,
} from "@/components/site/dead-letter-queue-panel-model";
import { DeadLetterQueuePanel } from "@/components/site/dead-letter-queue-panel";

const SAMPLE_PAGE = {
  generatedAt: "2026-07-03T00:00:05.000Z",
  limit: 25,
  offset: 0,
  total: 2,
  items: [
    {
      id: 2,
      jobType: "github-webhook",
      attempts: 1,
      lastError: "kaboom",
      createdAtMs: 2_000,
      deadAtMs: 9_000,
    },
    {
      id: 1,
      jobType: "agent-regate-pr",
      attempts: 3,
      lastError: null,
      createdAtMs: 1_000,
      deadAtMs: 5_000,
    },
  ],
};

describe("dead-letter queue panel model", () => {
  it("builds the query path with a default and a custom limit", () => {
    expect(buildDeadLetterQueuePath(0)).toBe("/v1/app/selfhost/queue/dead?limit=25&offset=0");
    expect(buildDeadLetterQueuePath(50, 10)).toBe("/v1/app/selfhost/queue/dead?limit=10&offset=50");
  });

  it("normalizes a valid page and rejects malformed payloads/items", () => {
    expect(normalizeDeadLetterQueuePage(SAMPLE_PAGE)).toEqual(SAMPLE_PAGE);
    expect(normalizeDeadLetterQueuePage(null)).toBeNull();
    expect(normalizeDeadLetterQueuePage({ generatedAt: "x" })).toBeNull();
    expect(
      normalizeDeadLetterQueuePage({
        ...SAMPLE_PAGE,
        items: [SAMPLE_PAGE.items[0], null, "bad", { id: "not-a-number" }],
      }),
    ).toMatchObject({ items: [SAMPLE_PAGE.items[0]] });
  });

  it("formats a null death/creation timestamp as an em dash, and a real one as a non-empty string", () => {
    expect(formatDeadLetterTimestamp(null)).toBe("—");
    const formatted = formatDeadLetterTimestamp(1_751_500_000_000);
    expect(formatted).not.toBe("—");
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("truncates a long error message and leaves a short one untouched", () => {
    const short = "boom";
    expect(truncateErrorMessage(short)).toBe(short);
    const long = "x".repeat(DEAD_LETTER_ERROR_TRUNCATE_LENGTH + 20);
    const truncated = truncateErrorMessage(long);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.length).toBeLessThan(long.length);
    // Exact boundary: a message of exactly maxLength characters must NOT be truncated.
    const exact = "y".repeat(DEAD_LETTER_ERROR_TRUNCATE_LENGTH);
    expect(truncateErrorMessage(exact)).toBe(exact);
  });
});

describe("DeadLetterQueuePanel", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE_PAGE });
  });

  it("renders populated dead-letter rows with job id, type, attempts, and formatted timestamps", async () => {
    render(<DeadLetterQueuePanel />);
    expect(await screen.findByText("github-webhook")).toBeTruthy();
    expect(screen.getByText("agent-regate-pr")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    expect(screen.getByText("2 dead")).toBeTruthy();
    // A null lastError renders as an em dash, not "null" or an empty cell.
    const dashCells = screen.getAllByText("—");
    expect(dashCells.length).toBeGreaterThan(0);
  });

  it("shows an empty state when the queue has no dead-letter jobs", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ...SAMPLE_PAGE, total: 0, items: [] } });
    render(<DeadLetterQueuePanel />);
    expect(await screen.findByText("No dead-letter jobs")).toBeTruthy();
  });

  it("shows an error state when the request fails", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "insufficient_role" });
    render(<DeadLetterQueuePanel />);
    expect(await screen.findByText("Couldn't load the dead-letter queue")).toBeTruthy();
    expect(screen.getByText("insufficient_role")).toBeTruthy();
  });

  it("shows an error state when the response is malformed", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { generatedAt: "x" } });
    render(<DeadLetterQueuePanel />);
    expect(await screen.findByText("Couldn't load the dead-letter queue")).toBeTruthy();
    expect(
      screen.getByText("The dead-letter queue endpoint returned an unexpected response."),
    ).toBeTruthy();
  });

  it("expands and collapses a truncated error message", async () => {
    const longError = "x".repeat(120);
    apiFetch.mockResolvedValue({
      ok: true,
      data: { ...SAMPLE_PAGE, items: [{ ...SAMPLE_PAGE.items[0], lastError: longError }] },
    });
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    expect(screen.queryByText(longError)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(screen.getByText(longError)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /show less/i }));
    expect(screen.queryByText(longError)).toBeNull();
  });

  it("does not render a Show more toggle for an error message under the truncation length", async () => {
    render(<DeadLetterQueuePanel />);
    await screen.findByText("kaboom");
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });

  it("disables Previous on the first page and fetches the next page on Next", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ...SAMPLE_PAGE, total: 60 } });
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    expect(screen.getByRole("link", { name: /previous/i }).getAttribute("aria-disabled")).toBe(
      "true",
    );

    apiFetch.mockClear();
    apiFetch.mockResolvedValue({
      ok: true,
      data: { ...SAMPLE_PAGE, offset: 25, total: 60, items: [{ ...SAMPLE_PAGE.items[0], id: 99 }] },
    });
    fireEvent.click(screen.getByRole("link", { name: /next/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead?limit=25&offset=25",
        expect.any(Object),
      ),
    );
    await screen.findByText("99");
  });

  it("disables Next once the last page is reached", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE_PAGE }); // total(2) <= limit(25) -- no next page
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");
    expect(screen.getByRole("link", { name: /next/i }).getAttribute("aria-disabled")).toBe("true");
  });
});
