import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so the component never touches the network.
const apiFetch = vi.fn();
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { AiReviewSettings } from "@/components/site/app-panels/ai-review-settings";

const REVIEWABILITY = [{ pr: "acme/widgets#1" }];

describe("AiReviewSettings", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, data: { configured: false } });
  });

  it("renders the provider key field as write-only (password) and never hydrates a stored key", async () => {
    // GET settings + GET ai-key both report a configured key, but only the last4 status comes back.
    apiFetch.mockResolvedValue({
      ok: true,
      data: { configured: true, last4: "7890", provider: "anthropic" },
    });
    render(<AiReviewSettings reviewability={REVIEWABILITY} />);

    const keyInput = (await screen.findByPlaceholderText("sk-ant-…")) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    expect(keyInput.value).toBe(""); // the stored key is NEVER written back into the field
    await waitFor(() => expect(screen.getByText(/configured/)).toBeTruthy());
    // The raw key never appears anywhere in the rendered DOM.
    expect(document.body.textContent).not.toContain("sk-ant-");
  });

  it("rejects a provider/key mismatch client-side without calling the key endpoint", async () => {
    render(<AiReviewSettings reviewability={REVIEWABILITY} />);
    await screen.findByPlaceholderText("sk-ant-…");
    await waitFor(() => expect(apiFetch).toHaveBeenCalled()); // initial load (GETs) settled
    apiFetch.mockClear();

    // Provider defaults to anthropic; paste an OpenAI-shaped key.
    fireEvent.change(screen.getByPlaceholderText("sk-ant-…"), {
      target: { value: "sk-openai-not-anthropic-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));

    expect(await screen.findByText(/Anthropic keys start with sk-ant-/)).toBeTruthy();
    // No write request was attempted.
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("posts a valid key, clears the input, and surfaces only the returned last4 status", async () => {
    render(<AiReviewSettings reviewability={REVIEWABILITY} />);
    await screen.findByPlaceholderText("sk-ant-…");
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    apiFetch.mockClear();
    apiFetch.mockResolvedValue({
      ok: true,
      data: { configured: true, last4: "4242", provider: "anthropic" },
    });

    const keyInput = screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-ant-valid-key-123456789" } });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));

    await waitFor(() => expect(screen.getByText(/Provider key stored/)).toBeTruthy());
    const post = apiFetch.mock.calls.find(
      ([, opts]) => (opts as { method?: string })?.method === "POST",
    );
    expect(post?.[0]).toContain("/ai-key");
    expect(keyInput.value).toBe(""); // input cleared after a successful save
  });
});
