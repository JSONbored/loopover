import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  fetchPortfolioQueueItems,
  PORTFOLIO_QUEUE_ITEMS_API_PATH,
  PORTFOLIO_QUEUE_RELEASE_API_PATH,
  PORTFOLIO_QUEUE_REQUEUE_API_PATH,
  releasePortfolioQueueItem,
  requeuePortfolioQueueItem,
  type PortfolioQueueActionItem,
  type PortfolioQueueActionResult,
} from "./lib/portfolio-queue-actions";
import { PortfolioPage, PortfolioQueueActionsSection } from "./routes/portfolio";
import type { PortfolioQueueResult } from "./lib/portfolio-queue";
import {
  handlePortfolioQueueActionsRequest,
  matchPortfolioQueueActionRoute,
  portfolioQueueActionsApiPlugin,
  type PortfolioQueueActionsApiDeps,
} from "../vite-portfolio-queue-actions-api";

const fixtureSummary = {
  total: 2,
  byStatus: { queued: 0, in_progress: 1, done: 1 },
  repos: [{ repoFullName: "acme/widgets", byStatus: { queued: 0, in_progress: 1, done: 1 }, total: 2 }],
  oldestQueuedAgeMs: null,
};

const inProgressItem: PortfolioQueueActionItem = {
  apiBaseUrl: "https://api.github.com",
  repoFullName: "acme/widgets",
  identifier: "issue:12",
  status: "in_progress",
};

const doneItem: PortfolioQueueActionItem = {
  apiBaseUrl: "https://api.github.com",
  repoFullName: "acme/widgets",
  identifier: "issue:7",
  status: "done",
};

function manyActionItems(count: number): PortfolioQueueActionItem[] {
  return Array.from({ length: count }, (_, index) => ({
    apiBaseUrl: "https://api.github.com",
    repoFullName: `acme/repo-${String(index).padStart(2, "0")}`,
    identifier: `issue:${index}`,
    // Alternating status so the default sort (in_progress first) still leaves enough rows for page 2.
    status: index % 2 === 0 ? ("in_progress" as const) : ("done" as const),
  }));
}

describe("PortfolioQueueActionsSection (#4857)", () => {
  it("renders a content-shaped loading skeleton (role=status), not the old flat loading text (#6511, #6831)", () => {
    // #6511: StateBoundary renders the skeleton INSTEAD of a loading title, so the old
    // "Loading actionable queue items…" text is intentionally gone; assert the placeholder instead.
    render(
      <PortfolioQueueActionsSection
        result={null}
        actionResult={null}
        pending={false}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByRole("status", { name: /loading actionable queue items/i })).toBeTruthy();
    expect(screen.getByTestId("queue-actions-skeleton")).toBeTruthy();
    expect(screen.queryByText("Loading actionable queue items…")).toBeNull();
    // Shaped like the real content, not one generic bar: the real table is not rendered yet.
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders the empty-state sentence verbatim, with no extra copy from the shared boundary", () => {
    // #6511: the whole original sentence is the EmptyState title and the description is suppressed, so the
    // rendered copy is byte-identical to the <p> it replaced -- not a reworded title/description split, and
    // none of StateBoundary's own default "This view has no records to show." boilerplate.
    render(
      <PortfolioQueueActionsSection
        result={{ ok: true, items: [] }}
        actionResult={null}
        pending={false}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByText("No in-progress or completed items to release or requeue right now.")).toBeTruthy();
    expect(screen.queryByText(/This view has no records to show/i)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(
      <PortfolioQueueActionsSection
        result={{ ok: false, error: "connection refused" }}
        actionResult={null}
        pending={false}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("shows Release for in_progress rows and Requeue for done rows", () => {
    const onRelease = vi.fn();
    const onRequeue = vi.fn();
    render(
      <PortfolioQueueActionsSection
        result={{ ok: true, items: [inProgressItem, doneItem] }}
        actionResult={null}
        pending={false}
        onRelease={onRelease}
        onRequeue={onRequeue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    expect(onRelease).toHaveBeenCalledWith(inProgressItem);
    expect(onRequeue).toHaveBeenCalledWith(doneItem);
  });

  it("does not paginate the queue-actions table at or below 20 rows (#6831)", () => {
    const items = manyActionItems(20);
    render(
      <PortfolioQueueActionsSection
        result={{ ok: true, items }}
        actionResult={null}
        pending={false}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.queryByRole("navigation", { name: /pagination/i })).toBeNull();
    expect(screen.getByText("acme/repo-00")).toBeTruthy();
    expect(screen.getByText("acme/repo-19")).toBeTruthy();
  });

  it("paginates the queue-actions table client-side above 20 rows (#6831)", () => {
    const items = manyActionItems(45);
    render(
      <PortfolioQueueActionsSection
        result={{ ok: true, items }}
        actionResult={null}
        pending={false}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    // Sorted in_progress first (even indices by name): page 1 ends at repo-38; repo-40 is the 21st.
    expect(screen.getByText("acme/repo-00")).toBeTruthy();
    expect(screen.queryByText("acme/repo-40")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("acme/repo-40")).toBeTruthy();
    expect(screen.queryByText("acme/repo-00")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /go to previous page/i }));
    expect(screen.getByText("acme/repo-00")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: /go to next page/i }));
    expect(screen.getByText("acme/repo-40")).toBeTruthy();
  });

  it("breaks same-status/same-repo ties by identifier ascending (#6831)", () => {
    const sameRepoDone: PortfolioQueueActionItem[] = [
      { ...doneItem, identifier: "issue:20" },
      { ...doneItem, identifier: "issue:7" },
    ];
    render(
      <PortfolioQueueActionsSection
        result={{ ok: true, items: sameRepoDone }}
        actionResult={null}
        pending={false}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("issue:20");
    expect(rows[2]?.textContent).toContain("issue:7");
  });

  it("disables action buttons while an action is pending", () => {
    render(
      <PortfolioQueueActionsSection
        result={{ ok: true, items: [inProgressItem] }}
        actionResult={null}
        pending={true}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect((screen.getByRole("button", { name: "Release" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a visible error when a queue action fails (#6090)", () => {
    const failed: PortfolioQueueActionResult = { ok: false, error: "queue_entry_not_in_progress" };
    render(
      <PortfolioQueueActionsSection
        result={{ ok: true, items: [inProgressItem] }}
        actionResult={failed}
        pending={false}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("queue_entry_not_in_progress");
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
  });
});

describe("PortfolioPage queue actions (#4857)", () => {
  const loadPortfolioQueue = async (): Promise<PortfolioQueueResult> => ({ ok: true, summary: fixtureSummary });
  const loadPortfolioQueueItems = async () => ({ ok: true as const, items: [inProgressItem] });

  it("loads actionable items and wires release through the injected action", async () => {
    const releaseItem = vi.fn(async () => ({
      ok: true as const,
      entry: { repoFullName: "acme/widgets", identifier: "issue:12", status: "queued" },
    }));
    render(
      <PortfolioPage
        loadPortfolioQueue={loadPortfolioQueue}
        loadPortfolioQueueItems={loadPortfolioQueueItems}
        releaseItem={releaseItem}
        pollIntervalMs={60_000}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Release" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(releaseItem).toHaveBeenCalledWith(inProgressItem));
  });

  it("wires requeue through the injected action for done rows (#6831)", async () => {
    const requeueItem = vi.fn(async () => ({
      ok: true as const,
      entry: { repoFullName: "acme/widgets", identifier: "issue:7", status: "queued" },
    }));
    render(
      <PortfolioPage
        loadPortfolioQueue={loadPortfolioQueue}
        loadPortfolioQueueItems={async () => ({ ok: true as const, items: [doneItem] })}
        requeueItem={requeueItem}
        pollIntervalMs={60_000}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Requeue" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    await waitFor(() => expect(requeueItem).toHaveBeenCalledWith(doneItem));
  });

  it("REGRESSION (#6090): a failing release action renders the error and does not re-fetch items as if it succeeded", async () => {
    const loadPortfolioQueueItems = vi.fn(async () => ({ ok: true as const, items: [inProgressItem] }));
    const releaseItem = vi.fn(async (): Promise<PortfolioQueueActionResult> => ({
      ok: false,
      error: "queue_entry_not_in_progress",
    }));
    render(
      <PortfolioPage
        loadPortfolioQueue={loadPortfolioQueue}
        loadPortfolioQueueItems={loadPortfolioQueueItems}
        releaseItem={releaseItem}
        pollIntervalMs={60_000}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Release" })).toBeTruthy());
    expect(loadPortfolioQueueItems).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("queue_entry_not_in_progress"));
    expect(releaseItem).toHaveBeenCalledWith(inProgressItem);
    expect(loadPortfolioQueueItems).toHaveBeenCalledTimes(1);
  });
});

describe("fetchPortfolioQueueItems / release / requeue (#4857)", () => {
  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("fetchPortfolioQueueItems returns typed items from a well-formed payload", async () => {
    let requested: string | undefined;
    const result = await fetchPortfolioQueueItems(async (input) => {
      requested = String(input);
      return jsonResponse(200, { items: [inProgressItem] });
    });
    expect(requested).toBe(PORTFOLIO_QUEUE_ITEMS_API_PATH);
    expect(result).toEqual({ ok: true, items: [inProgressItem] });
  });

  it("releasePortfolioQueueItem POSTs to the release path with the item body", async () => {
    let requested: string | undefined;
    let init: RequestInit | undefined;
    const result = await releasePortfolioQueueItem(inProgressItem, async (input, options) => {
      requested = String(input);
      init = options;
      return jsonResponse(200, { entry: { repoFullName: "acme/widgets", identifier: "issue:12", status: "queued" } });
    });
    expect(requested).toBe(PORTFOLIO_QUEUE_RELEASE_API_PATH);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      repoFullName: inProgressItem.repoFullName,
      identifier: inProgressItem.identifier,
      apiBaseUrl: inProgressItem.apiBaseUrl,
    });
    expect(result.ok).toBe(true);
  });

  it("requeuePortfolioQueueItem POSTs to the requeue path", async () => {
    let requested: string | undefined;
    await requeuePortfolioQueueItem(doneItem, async (input) => {
      requested = String(input);
      return jsonResponse(200, { entry: { repoFullName: "acme/widgets", identifier: "issue:7", status: "queued" } });
    });
    expect(requested).toBe(PORTFOLIO_QUEUE_REQUEUE_API_PATH);
  });

  it("surfaces API error codes from non-2xx action responses", async () => {
    expect(
      await releasePortfolioQueueItem(inProgressItem, async () =>
        jsonResponse(409, { error: "queue_entry_not_in_progress" }),
      ),
    ).toEqual({ ok: false, error: "queue_entry_not_in_progress" });
  });
});

describe("matchPortfolioQueueActionRoute / handlePortfolioQueueActionsRequest (#4857)", () => {
  function deps(overrides: Partial<PortfolioQueueActionsApiDeps> = {}): PortfolioQueueActionsApiDeps {
    const entries = [
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        identifier: "issue:12",
        status: "in_progress",
        priority: 1,
        enqueuedAt: "2026-07-10T06:00:00.000Z",
      },
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        identifier: "issue:7",
        status: "done",
        priority: 1,
        enqueuedAt: "2026-07-10T05:00:00.000Z",
      },
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        identifier: "issue:9",
        status: "queued",
        priority: 1,
        enqueuedAt: "2026-07-10T04:00:00.000Z",
      },
    ];
    return {
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/home/miner/.config/loopover-miner/portfolio-queue.sqlite3",
        initPortfolioQueueStore: () => ({
          listQueue: () => entries,
          reclaimStuckItem: (repoFullName, identifier) => {
            const match = entries.find(
              (entry) =>
                entry.repoFullName === repoFullName &&
                entry.identifier === identifier &&
                entry.status === "in_progress",
            );
            if (!match) return null;
            match.status = "queued";
            return { ...match };
          },
          requeueItem: (repoFullName, identifier) => {
            const match = entries.find(
              (entry) =>
                entry.repoFullName === repoFullName && entry.identifier === identifier && entry.status === "done",
            );
            if (!match) return null;
            match.status = "queued";
            return { ...match };
          },
          close: () => undefined,
        }),
      }),
      fileExists: () => true,
      ...overrides,
    };
  }

  it("matches the three portfolio-queue action routes", () => {
    expect(matchPortfolioQueueActionRoute("GET", "/api/portfolio-queue/items")).toBe("items-get");
    expect(matchPortfolioQueueActionRoute("POST", "/api/portfolio-queue/release")).toBe("release-post");
    expect(matchPortfolioQueueActionRoute("POST", "/api/portfolio-queue/requeue")).toBe("requeue-post");
    expect(matchPortfolioQueueActionRoute("GET", "/api/portfolio-queue/release")).toBeNull();
  });

  it("GET items returns only in_progress and done rows", async () => {
    const handled = await handlePortfolioQueueActionsRequest("GET", "/api/portfolio-queue/items", "", deps());
    expect(handled?.status).toBe(200);
    const body = JSON.parse(handled?.body ?? "{}") as { items: PortfolioQueueActionItem[] };
    expect(body.items).toEqual([
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        identifier: "issue:12",
        status: "in_progress",
      },
      {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        identifier: "issue:7",
        status: "done",
      },
    ]);
  });

  it("GET items serves an empty list on a fresh install without opening the store", async () => {
    let opened = false;
    const handled = await handlePortfolioQueueActionsRequest(
      "GET",
      "/api/portfolio-queue/items",
      "",
      deps({
        fileExists: () => false,
        loadPortfolioQueueModule: async () => ({
          resolvePortfolioQueueDbPath: () => "/nowhere/portfolio-queue.sqlite3",
          initPortfolioQueueStore: () => {
            opened = true;
            throw new Error("should not open store");
          },
        }),
      }),
    );
    expect(opened).toBe(false);
    expect(JSON.parse(handled?.body ?? "{}")).toEqual({ items: [] });
  });

  it("POST release reclaims an in_progress item and POST requeue revives a done item", async () => {
    const release = await handlePortfolioQueueActionsRequest(
      "POST",
      "/api/portfolio-queue/release",
      JSON.stringify({ repoFullName: "acme/widgets", identifier: "issue:12" }),
      deps(),
    );
    expect(release?.status).toBe(200);
    expect(JSON.parse(release?.body ?? "{}")).toEqual({
      entry: { repoFullName: "acme/widgets", identifier: "issue:12", status: "queued" },
    });

    const requeue = await handlePortfolioQueueActionsRequest(
      "POST",
      "/api/portfolio-queue/requeue",
      JSON.stringify({ repoFullName: "acme/widgets", identifier: "issue:7" }),
      deps(),
    );
    expect(requeue?.status).toBe(200);
    expect(JSON.parse(requeue?.body ?? "{}")).toEqual({
      entry: { repoFullName: "acme/widgets", identifier: "issue:7", status: "queued" },
    });
  });

  it("POST release returns 409 when the item is not in_progress", async () => {
    const handled = await handlePortfolioQueueActionsRequest(
      "POST",
      "/api/portfolio-queue/release",
      JSON.stringify({ repoFullName: "acme/widgets", identifier: "issue:7" }),
      deps(),
    );
    expect(handled).toEqual({ status: 409, body: JSON.stringify({ error: "queue_entry_not_in_progress" }) });
  });

  it("POST requeue returns 409 when the item is not requeuable", async () => {
    const handled = await handlePortfolioQueueActionsRequest(
      "POST",
      "/api/portfolio-queue/requeue",
      JSON.stringify({ repoFullName: "acme/widgets", identifier: "issue:12" }),
      deps(),
    );
    expect(handled).toEqual({ status: 409, body: JSON.stringify({ error: "queue_entry_not_requeuable" }) });
  });

  it("returns 400 for a malformed POST body", async () => {
    const handled = await handlePortfolioQueueActionsRequest("POST", "/api/portfolio-queue/release", "{bad", deps());
    expect(handled?.status).toBe(400);
  });
});

describe("portfolioQueueActionsApiPlugin (#4857)", () => {
  it("registers middleware that serves GET /api/portfolio-queue/items", async () => {
    type CapturedRequestHandler = (
      req: { method?: string; url?: string },
      res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
      next: () => void,
    ) => void;
    let captured: CapturedRequestHandler | undefined;
    const plugin = portfolioQueueActionsApiPlugin({
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/home/miner/.config/loopover-miner/portfolio-queue.sqlite3",
        initPortfolioQueueStore: () => ({
          listQueue: () => [inProgressItem],
          reclaimStuckItem: () => null,
          requeueItem: () => null,
          close: () => undefined,
        }),
      }),
      fileExists: () => true,
    });
    const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
    // @ts-expect-error -- the test double only implements the subset of Vite's ViteDevServer this plugin reads.
    plugin.configureServer(server);
    if (!captured) throw new Error("plugin did not register middleware");
    let ended: string | undefined;
    captured(
      { method: "GET", url: "/api/portfolio-queue/items" },
      {
        statusCode: 0,
        setHeader: () => undefined,
        end(body: string) {
          ended = body;
        },
      },
      () => undefined,
    );
    await vi.waitFor(() => expect(ended).toBeTruthy());
    expect(JSON.parse(ended ?? "{}")).toEqual({ items: [inProgressItem] });
  });
});
