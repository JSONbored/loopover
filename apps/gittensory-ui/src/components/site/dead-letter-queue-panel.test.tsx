import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import {
  buildDeadLetterJobActionPath,
  buildDeadLetterQueuePath,
  DEAD_LETTER_ERROR_TRUNCATE_LENGTH,
  DEAD_LETTER_QUEUE_PURGE_PATH,
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

  it("builds the per-job action path for replay vs. delete", () => {
    expect(buildDeadLetterJobActionPath(123, "replay")).toBe(
      "/v1/app/selfhost/queue/dead/123/replay",
    );
    expect(buildDeadLetterJobActionPath(123, "delete")).toBe("/v1/app/selfhost/queue/dead/123");
  });

  it("exposes the bulk purge path", () => {
    expect(DEAD_LETTER_QUEUE_PURGE_PATH).toBe("/v1/app/selfhost/queue/dead");
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

describe("DeadLetterQueuePanel row actions and purge", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  // The row for item id 2 ("github-webhook") has both Replay and Delete buttons.
  function getRowButton(name: "Replay" | "Delete") {
    return screen.getAllByRole("button", { name })[0];
  }

  it("replay success: POSTs the right path, toasts success, and refetches", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    apiFetch.mockResolvedValueOnce({ ok: true, data: { ok: true, id: 2 } }); // replay call
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // refetch after reload

    fireEvent.click(getRowButton("Replay"));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead/2/replay",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    // Refetch happened: base GET path called again.
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead?limit=25&offset=0",
        expect.any(Object),
      ),
    );
  });

  it("replay failure: toasts an error and does NOT refetch", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    apiFetch.mockResolvedValueOnce({ ok: false, message: "not found" }); // replay call fails

    fireEvent.click(getRowButton("Replay"));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead/2/replay",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    // No refetch: only the initial GET + the failed replay call were made.
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  // Delete is confirm-gated (like Purge all): clicking the row trigger opens an AlertDialog, and only the
  // dialog's own destructive confirm action actually fires the DELETE call.
  function confirmRowDelete() {
    fireEvent.click(getRowButton("Delete"));
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);
  }

  it("delete: clicking the row trigger opens a confirmation dialog naming the job id", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE });
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    fireEvent.click(getRowButton("Delete"));
    expect(await screen.findByText("Delete job #2?")).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalledWith(
      "https://api.test/v1/app/selfhost/queue/dead/2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("delete: clicking Cancel closes the dialog without calling the delete endpoint", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE });
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    fireEvent.click(getRowButton("Delete"));
    await screen.findByText("Delete job #2?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Delete job #2?")).toBeNull());
    expect(apiFetch).not.toHaveBeenCalledWith(
      "https://api.test/v1/app/selfhost/queue/dead/2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("delete success: confirming DELETEs the right path, toasts success, and refetches", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    apiFetch.mockResolvedValueOnce({ ok: true, data: { ok: true, id: 2 } }); // delete call
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // refetch after reload

    confirmRowDelete();

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead/2",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead?limit=25&offset=0",
        expect.any(Object),
      ),
    );
  });

  it("delete failure: confirming toasts an error and does NOT refetch", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    apiFetch.mockResolvedValueOnce({ ok: false, message: "not found" }); // delete call fails

    confirmRowDelete();

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead/2",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("disables only the acted-on row's buttons while a request is in flight", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    let resolveReplay: (value: unknown) => void = () => {};
    apiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReplay = resolve;
      }),
    );

    const replayButtons = screen.getAllByRole("button", { name: "Replay" }) as HTMLButtonElement[];
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" }) as HTMLButtonElement[];
    fireEvent.click(replayButtons[0]);

    await waitFor(() => expect(replayButtons[0].disabled).toBe(true));
    expect(deleteButtons[0].disabled).toBe(true);
    // The other row (job id 1) stays enabled.
    expect(replayButtons[1].disabled).toBe(false);
    expect(deleteButtons[1].disabled).toBe(false);

    resolveReplay({ ok: true, data: { ok: true, id: 2 } });
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE });
    await waitFor(() => expect(replayButtons[0].disabled).toBe(false));
  });

  it("Purge all opens a confirmation dialog with the expected warning text", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE });
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    fireEvent.click(screen.getByRole("button", { name: "Purge all" }));
    expect(
      await screen.findByText(
        "This permanently deletes every dead-letter job. This cannot be undone.",
      ),
    ).toBeTruthy();
  });

  it("Purge all: clicking Cancel closes the dialog without calling the purge endpoint", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE });
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    fireEvent.click(screen.getByRole("button", { name: "Purge all" }));
    await screen.findByText(
      "This permanently deletes every dead-letter job. This cannot be undone.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByText(
          "This permanently deletes every dead-letter job. This cannot be undone.",
        ),
      ).toBeNull(),
    );
    expect(apiFetch).not.toHaveBeenCalledWith(
      "https://api.test/v1/app/selfhost/queue/dead",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("Purge all: confirming DELETEs the purge path, shows the purged count, and refetches", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    apiFetch.mockResolvedValueOnce({ ok: true, data: { ok: true, purged: 2 } }); // purge call
    apiFetch.mockResolvedValueOnce({ ok: true, data: { ...SAMPLE_PAGE, total: 0, items: [] } }); // refetch

    fireEvent.click(screen.getByRole("button", { name: "Purge all" }));
    await screen.findByText(
      "This permanently deletes every dead-letter job. This cannot be undone.",
    );
    // Two elements read "Purge all": the trigger and the destructive confirm action.
    const purgeButtons = screen.getAllByRole("button", { name: "Purge all" });
    fireEvent.click(purgeButtons[purgeButtons.length - 1]);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [, options] = toastSuccess.mock.calls[0] as [string, { description?: string }];
    expect(options.description).toContain("2");
    expect(await screen.findByText("No dead-letter jobs")).toBeTruthy();
  });

  it("Purge all: confirming a single-job purge uses the singular 'job' wording", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    apiFetch.mockResolvedValueOnce({ ok: true, data: { ok: true, purged: 1 } }); // purge call
    apiFetch.mockResolvedValueOnce({ ok: true, data: { ...SAMPLE_PAGE, total: 0, items: [] } }); // refetch

    fireEvent.click(screen.getByRole("button", { name: "Purge all" }));
    await screen.findByText(
      "This permanently deletes every dead-letter job. This cannot be undone.",
    );
    const purgeButtons = screen.getAllByRole("button", { name: "Purge all" });
    fireEvent.click(purgeButtons[purgeButtons.length - 1]);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [, options] = toastSuccess.mock.calls[0] as [string, { description?: string }];
    expect(options.description).toBe("Purged 1 job.");
  });

  it("Purge all: failure toasts an error", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: SAMPLE_PAGE }); // initial GET
    render(<DeadLetterQueuePanel />);
    await screen.findByText("github-webhook");

    apiFetch.mockResolvedValueOnce({ ok: false, message: "unsupported" }); // purge call fails

    fireEvent.click(screen.getByRole("button", { name: "Purge all" }));
    await screen.findByText(
      "This permanently deletes every dead-letter job. This cannot be undone.",
    );
    const purgeButtons = screen.getAllByRole("button", { name: "Purge all" });
    fireEvent.click(purgeButtons[purgeButtons.length - 1]);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "https://api.test/v1/app/selfhost/queue/dead",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("disables the Purge all trigger when the queue is empty", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ...SAMPLE_PAGE, total: 0, items: [] } });
    render(<DeadLetterQueuePanel />);
    await screen.findByText("No dead-letter jobs");
    expect((screen.getByRole("button", { name: "Purge all" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
