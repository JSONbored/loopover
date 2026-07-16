import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so the component never touches the network.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { ChatQaPanel } from "@/components/site/app-panels/chat-qa-panel";

const ELIGIBLE = [
  { pr: "acme/widgets#1", title: "Add cursor pagination", chatQaEnabled: true },
  { pr: "acme/widgets#2", title: "Fix flaky test", chatQaEnabled: false },
];

async function askQuestion(question = "Why is this blocked?") {
  fireEvent.change(screen.getByPlaceholderText(/why is this pr blocked/i), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: /ask/i }));
}

describe("ChatQaPanel (#6489)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("renders nothing at all when no PR in view has chatQa enabled (not a disabled-looking version of the panel)", () => {
    const { container } = render(
      <ChatQaPanel reviewability={[{ pr: "acme/widgets#2", title: "Fix flaky test", chatQaEnabled: false }]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("renders nothing when the reviewability list is empty", () => {
    const { container } = render(<ChatQaPanel reviewability={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("only lists chatQa-enabled PRs in the selector", () => {
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    expect(screen.getByText(/acme\/widgets#1 — Add cursor pagination/)).toBeTruthy();
    expect(screen.queryByText(/acme\/widgets#2/)).toBeNull();
  });

  it("posts the question to the selected PR's chat-qa route and renders an 'ok' answer", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: "ok", model: "test-model", estimatedNeurons: 12, text: "This PR is blocked on a failing check." } });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion("Why is this blocked?");

    await waitFor(() => expect(screen.getByText("This PR is blocked on a failing check.")).toBeTruthy());
    expect(screen.getByText("answered")).toBeTruthy();
    expect(screen.getByText("test-model")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.test/v1/repos/acme/widgets/pulls/1/chat-qa",
      expect.objectContaining({ method: "POST", label: "Chat Q&A", body: JSON.stringify({ question: "Why is this blocked?" }) }),
    );
  });

  it("renders the 'disabled' status distinctly", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: "disabled", reason: "Chat Q&A is not enabled on this instance (settings.advisoryAiRouting.chatQa is off)." } });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("Not enabled")).toBeTruthy());
    expect(screen.getByText(/settings\.advisoryAiRouting\.chatQa is off/)).toBeTruthy();
  });

  it("renders the 'unavailable' status distinctly", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: "unavailable", reason: "Local advisory inference (env.AI_ADVISORY) is not configured." } });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("Unavailable")).toBeTruthy());
    expect(screen.getByText(/env\.AI_ADVISORY.*not configured/)).toBeTruthy();
  });

  it("renders the 'declined' status with its fallback command suggestion", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { status: "declined", reason: "No cached deterministic facts are available.", suggestion: "Run `@loopover preflight` or `@loopover blockers` for the deterministic readiness facts." },
    });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("Declined")).toBeTruthy());
    expect(screen.getByText("@loopover preflight")).toBeTruthy();
  });

  it("renders the 'quota_exceeded' status with the remaining budget", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: "quota_exceeded", model: "test-model", estimatedNeurons: 900, remainingBudget: 0 } });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("Daily AI budget reached")).toBeTruthy());
    expect(screen.getByText(/Remaining budget: 0 neurons/)).toBeTruthy();
  });

  it("renders the 'unsafe' status distinctly", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: "unsafe", model: "test-model", estimatedNeurons: 20, reason: "chat answer failed public sanitizer" } });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("Answer withheld")).toBeTruthy());
  });

  it("renders the 'error' status distinctly", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: "error", model: "test-model", estimatedNeurons: 0, reason: "empty_chat_answer" } });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("Answer failed")).toBeTruthy());
    expect(screen.getByText(/empty_chat_answer/)).toBeTruthy();
  });

  it("renders the route-local 'rate_limited' status distinctly", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: "rate_limited", reason: "The chat command has reached its rate limit (2 within 24h), shared with the @loopover chat PR-comment command." } });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("Rate limited")).toBeTruthy());
    expect(screen.getByText(/shared with the @loopover chat PR-comment command/)).toBeTruthy();
  });

  it("shows the request-level error message when the fetch itself fails", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "503 Service Unavailable" });
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    await askQuestion();
    await waitFor(() => expect(screen.getByText("503 Service Unavailable")).toBeTruthy());
  });

  it("disables the Ask button until a question is entered", () => {
    render(<ChatQaPanel reviewability={ELIGIBLE} />);
    expect((screen.getByRole("button", { name: /ask/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/why is this pr blocked/i), { target: { value: "Why?" } });
    expect((screen.getByRole("button", { name: /ask/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
