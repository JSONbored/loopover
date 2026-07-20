import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState, ErrorState, LoadingState, StateBoundary } from "./state-views";

describe("LoadingState / EmptyState / ErrorState copy (#793)", () => {
  it("LoadingState shows its default copy under a polite status role", () => {
    render(<LoadingState />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("LoadingState honors an overridden title", () => {
    render(<LoadingState title="Fetching signals" />);
    expect(screen.getByText("Fetching signals")).toBeTruthy();
  });

  it("EmptyState shows its default empty copy", () => {
    render(<EmptyState />);
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
  });

  it("ErrorState shows generic (server-answered) copy under an alert role by default", () => {
    render(<ErrorState />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Couldn't load this")).toBeTruthy();
    expect(screen.getByText(/Something went wrong fetching this data/)).toBeTruthy();
  });

  it("ErrorState shows connectivity copy for a network errorKind, and treats timeout the same way", () => {
    const { unmount } = render(<ErrorState errorKind="network" />);
    expect(screen.getByText("Can't reach the server")).toBeTruthy();
    expect(screen.getByText(/couldn't reach the API/)).toBeTruthy();
    unmount();

    render(<ErrorState errorKind="timeout" />);
    expect(screen.getByText("Can't reach the server")).toBeTruthy();
  });

  it("ErrorState keeps the generic copy for a non-network (http) errorKind", () => {
    render(<ErrorState errorKind="http" />);
    expect(screen.getByText("Couldn't load this")).toBeTruthy();
  });

  it("ErrorState: an explicit title/description always wins over the errorKind default", () => {
    render(<ErrorState errorKind="network" title="Custom title" description="Custom description" />);
    expect(screen.getByText("Custom title")).toBeTruthy();
    expect(screen.getByText("Custom description")).toBeTruthy();
  });
});

describe("StateBoundary precedence (#793)", () => {
  const child = <div>child content</div>;

  it("renders loading ahead of error/empty/children when isLoading", () => {
    render(
      <StateBoundary isLoading isError isEmpty>
        {child}
      </StateBoundary>,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("child content")).toBeNull();
  });

  it("renders error ahead of empty/children when isError (and not loading)", () => {
    render(
      <StateBoundary isError isEmpty>
        {child}
      </StateBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("child content")).toBeNull();
  });

  it("renders empty ahead of children when isEmpty (and not loading/error)", () => {
    render(<StateBoundary isEmpty>{child}</StateBoundary>);
    // StateBoundary supplies its own empty default ("No data available yet"); the bare EmptyState default
    // ("Nothing here yet") is covered separately above.
    expect(screen.getByText("No data available yet")).toBeTruthy();
    expect(screen.queryByText("child content")).toBeNull();
  });

  it("renders children when no loading/error/empty flag is set", () => {
    render(<StateBoundary>{child}</StateBoundary>);
    expect(screen.getByText("child content")).toBeTruthy();
  });

  it("uses its own generic default error title when no errorKind is given", () => {
    render(<StateBoundary isError>{child}</StateBoundary>);
    expect(screen.getByText("Couldn't load data")).toBeTruthy();
  });

  it("falls through to ErrorState's network-aware default title when errorKind is a network kind", () => {
    render(
      <StateBoundary isError errorKind="network">
        {child}
      </StateBoundary>,
    );
    expect(screen.getByText("Can't reach the server")).toBeTruthy();
  });
});
