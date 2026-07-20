import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { notifyApiFailure } = vi.hoisted(() => ({ notifyApiFailure: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  notifyApiFailure: (...args: unknown[]) => notifyApiFailure(...args),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { ErrorState, StateBoundary } from "@/components/site/state-views";

describe("ErrorState network-vs-API distinction (#793)", () => {
  it("uses the generic 'couldn't load' copy when no errorKind is given (unchanged default)", () => {
    render(<ErrorState />);
    expect(screen.getByText("Couldn't load this")).toBeTruthy();
  });

  it("uses connectivity-specific copy for a network errorKind", () => {
    render(<ErrorState errorKind="network" />);
    expect(screen.getByText("Can't reach the server")).toBeTruthy();
  });

  it("uses connectivity-specific copy for a timeout errorKind too", () => {
    render(<ErrorState errorKind="timeout" />);
    expect(screen.getByText("Can't reach the server")).toBeTruthy();
  });

  it("falls back to the generic copy for an http errorKind", () => {
    render(<ErrorState errorKind="http" />);
    expect(screen.getByText("Couldn't load this")).toBeTruthy();
  });

  it("lets an explicit title/description override the errorKind-derived copy", () => {
    render(
      <ErrorState errorKind="network" title="Custom title" description="Custom description" />,
    );
    expect(screen.getByText("Custom title")).toBeTruthy();
    expect(screen.getByText("Custom description")).toBeTruthy();
    expect(screen.queryByText("Can't reach the server")).toBeNull();
  });
});

describe("StateBoundary loadingSkeleton (#793)", () => {
  it("renders the default spinner LoadingState when no skeleton is given", () => {
    render(
      <StateBoundary isLoading>
        <div>content</div>
      </StateBoundary>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("content")).toBeNull();
  });

  it("renders the provided skeleton instead of the spinner when loading", () => {
    render(
      <StateBoundary isLoading loadingSkeleton={<div data-testid="skeleton">placeholder</div>}>
        <div>content</div>
      </StateBoundary>,
    );
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("content")).toBeNull();
  });
});

describe("StateBoundary errorKind passthrough (#793)", () => {
  it("keeps the pre-#793 default error copy when no errorKind is given", () => {
    render(
      <StateBoundary isError>
        <div>content</div>
      </StateBoundary>,
    );
    expect(screen.getByText("Couldn't load data")).toBeTruthy();
  });

  it("falls through to ErrorState's network-aware copy when errorKind is network and no override is given", () => {
    render(
      <StateBoundary isError errorKind="network">
        <div>content</div>
      </StateBoundary>,
    );
    expect(screen.getByText("Can't reach the server")).toBeTruthy();
    expect(screen.queryByText("Couldn't load data")).toBeNull();
  });

  it("lets an explicit errorTitle/errorDescription win even with a network errorKind", () => {
    render(
      <StateBoundary
        isError
        errorKind="network"
        errorTitle="Custom title"
        errorDescription="Custom description"
      >
        <div>content</div>
      </StateBoundary>,
    );
    expect(screen.getByText("Custom title")).toBeTruthy();
    expect(screen.getByText("Custom description")).toBeTruthy();
  });

  it("passes the real errorKind (not a hardcoded 'network') to the error-failure notifier", () => {
    render(
      <StateBoundary isError errorKind="http" errorLabel="Widgets">
        <div>content</div>
      </StateBoundary>,
    );
    expect(notifyApiFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "http" }));
  });

  it("defaults the notifier kind to 'network' when no errorKind is given, matching pre-#793 behavior", () => {
    render(
      <StateBoundary isError errorLabel="Widgets">
        <div>content</div>
      </StateBoundary>,
    );
    expect(notifyApiFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "network" }));
  });
});

describe("StateBoundary retry/refresh actions (#793 regression guard)", () => {
  it("still invokes onRetry from the error state's retry button", () => {
    const onRetry = vi.fn();
    render(
      <StateBoundary isError onRetry={onRetry}>
        <div>content</div>
      </StateBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders children unchanged when neither loading, error, nor empty", () => {
    render(
      <StateBoundary>
        <div>content</div>
      </StateBoundary>,
    );
    expect(screen.getByText("content")).toBeTruthy();
  });
});

describe("StateBoundary onFailureNotify edge-trigger (#7436)", () => {
  it("notifies exactly once while staying in error across unstable callback identities, then again on re-entry", () => {
    notifyApiFailure.mockClear();
    const { rerender } = render(
      <StateBoundary isError errorLabel="Widgets" onRetry={() => {}}>
        <div>content</div>
      </StateBoundary>,
    );
    expect(notifyApiFailure).toHaveBeenCalledTimes(1);

    // Simulate the app wrapper's fresh onFailureNotify arrow + a fresh onRetry each parent render
    // while isError stays true — must NOT re-fire.
    for (let i = 0; i < 4; i += 1) {
      rerender(
        <StateBoundary isError errorLabel="Widgets" onRetry={() => {}}>
          <div>content</div>
        </StateBoundary>,
      );
    }
    expect(notifyApiFailure).toHaveBeenCalledTimes(1);

    // Leave the error state…
    rerender(
      <StateBoundary isError={false} errorLabel="Widgets" onRetry={() => {}}>
        <div>content</div>
      </StateBoundary>,
    );
    expect(notifyApiFailure).toHaveBeenCalledTimes(1);

    // …then re-enter: exactly one more notification for the second false→true edge.
    rerender(
      <StateBoundary isError errorLabel="Widgets" onRetry={() => {}}>
        <div>content</div>
      </StateBoundary>,
    );
    expect(notifyApiFailure).toHaveBeenCalledTimes(2);
  });
});
