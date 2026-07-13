// Client for the local portfolio-queue release/requeue write API (#4857, the queue half of "Add real actions to
// the miner-ui"). Mirrors the CLI's `gittensory-miner queue release` / `queue requeue` commands via the
// authenticated dev-server bridge in vite-portfolio-queue-actions-api.ts.

export const PORTFOLIO_QUEUE_ITEMS_API_PATH = "/api/portfolio-queue/items";
export const PORTFOLIO_QUEUE_RELEASE_API_PATH = "/api/portfolio-queue/release";
export const PORTFOLIO_QUEUE_REQUEUE_API_PATH = "/api/portfolio-queue/requeue";

export type PortfolioQueueActionItem = {
  apiBaseUrl: string;
  repoFullName: string;
  identifier: string;
  status: "in_progress" | "done";
};

export type PortfolioQueueItemsResult = { ok: true; items: PortfolioQueueActionItem[] } | { ok: false; error: string };

export type PortfolioQueueActionResult =
  { ok: true; entry: { repoFullName: string; identifier: string; status: string } } | { ok: false; error: string };

function isPortfolioQueueActionItem(value: unknown): value is PortfolioQueueActionItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.apiBaseUrl === "string" &&
    typeof item.repoFullName === "string" &&
    typeof item.identifier === "string" &&
    (item.status === "in_progress" || item.status === "done")
  );
}

function parseItemsResponse(response: Response, label: string): Promise<PortfolioQueueItemsResult> {
  if (!response.ok) return Promise.resolve({ ok: false, error: `${label} responded ${response.status}` });
  return response.json().then((payload: unknown) => {
    const items = (payload as { items?: unknown }).items;
    if (!Array.isArray(items) || !items.every(isPortfolioQueueActionItem)) {
      return { ok: false, error: `${label} returned an unexpected payload shape` };
    }
    return { ok: true, items };
  });
}

function parseActionResponse(response: Response, label: string): Promise<PortfolioQueueActionResult> {
  if (!response.ok) {
    return response
      .json()
      .catch(() => ({}))
      .then((payload: unknown) => {
        const error = (payload as { error?: unknown }).error;
        if (typeof error === "string" && error) {
          return { ok: false, error };
        }
        return { ok: false, error: `${label} responded ${response.status}` };
      });
  }
  return response.json().then((payload: unknown) => {
    const entry = (payload as { entry?: unknown }).entry;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { repoFullName?: unknown }).repoFullName !== "string" ||
      typeof (entry as { identifier?: unknown }).identifier !== "string" ||
      typeof (entry as { status?: unknown }).status !== "string"
    ) {
      return { ok: false, error: `${label} returned an unexpected payload shape` };
    }
    return { ok: true, entry: entry as { repoFullName: string; identifier: string; status: string } };
  });
}

/** Fetch actionable queue rows (in_progress + done) for release/requeue controls. */
export async function fetchPortfolioQueueItems(fetchImpl: typeof fetch = fetch): Promise<PortfolioQueueItemsResult> {
  try {
    const response = await fetchImpl(PORTFOLIO_QUEUE_ITEMS_API_PATH);
    return await parseItemsResponse(response, "local portfolio-queue items API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local portfolio-queue items API",
    };
  }
}

/** Release a claimed (in_progress) item back to queued — mirrors `gittensory-miner queue release`. */
export function releasePortfolioQueueItem(
  item: Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch,
): Promise<PortfolioQueueActionResult> {
  return postPortfolioQueueAction(PORTFOLIO_QUEUE_RELEASE_API_PATH, item, fetchImpl);
}

/** Requeue a completed (done) item — mirrors `gittensory-miner queue requeue`. */
export function requeuePortfolioQueueItem(
  item: Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch,
): Promise<PortfolioQueueActionResult> {
  return postPortfolioQueueAction(PORTFOLIO_QUEUE_REQUEUE_API_PATH, item, fetchImpl);
}

async function postPortfolioQueueAction(
  path: string,
  item: Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">,
  fetchImpl: typeof fetch,
): Promise<PortfolioQueueActionResult> {
  try {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoFullName: item.repoFullName,
        identifier: item.identifier,
        apiBaseUrl: item.apiBaseUrl,
      }),
    });
    return await parseActionResponse(response, "local portfolio-queue action API");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local portfolio-queue action API",
    };
  }
}
