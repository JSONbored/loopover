import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * Test helpers that supply the same react-query context the app provides at its root (#9588).
 *
 * `useApiResource` reads through react-query, so anything rendering a panel that uses it needs a client.
 * One helper rather than a wrapper per test file: several files had already grown their own copy, and a
 * shared one is what keeps the client's TEST defaults (no retries, no cross-test cache) consistent —
 * a retrying client turns an asserted error state into a timeout, and a shared cache lets one case's
 * response answer the next case's request.
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

/** Render `ui` inside a fresh client. */
export function renderWithQueryClient(ui: ReactNode): ReturnType<typeof render> {
  const client = createTestQueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** `renderHook` inside a fresh client, preserving `initialProps` so rerender-driven tests still work. */
export function renderHookWithQueryClient<TResult, TProps>(
  callback: (props: TProps) => TResult,
  options?: { initialProps?: TProps },
): ReturnType<typeof renderHook<TResult, TProps>> {
  const client = createTestQueryClient();
  return renderHook(callback, {
    ...options,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
