import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #6824: create-token used to swallow clipboard rejections and still toast success. Mock the toast
// and api layers so the regression can assert the exact success/failure branch without a live API.
const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success, error } }));

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/api/origin", () => ({
  getApiOrigin: () => "https://api.example.test",
}));

import { ExtensionTokenButton } from "./extension";

const TOKEN = "ext_test_token_6824";

function mockClipboard(writeText: () => Promise<void>) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: spy },
    configurable: true,
    writable: true,
  });
  return spy;
}

describe("ExtensionTokenButton clipboard honesty (#6824)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockResolvedValue({
      ok: true,
      data: { token: TOKEN },
      status: 200,
      durationMs: 1,
      message: undefined,
    });
  });

  it("toasts success only when the auto-copy after create actually writes", async () => {
    const writeText = mockClipboard(() => Promise.resolve());
    render(<ExtensionTokenButton />);

    fireEvent.click(screen.getByRole("button", { name: "Create extension token" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Extension token created", {
        description: "Copied to clipboard.",
      }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(screen.getByTestId("extension-token-value").textContent).toBe(TOKEN);
    expect(screen.getByRole("button", { name: "Copy extension token" })).toBeTruthy();
  });

  it("does not claim clipboard success when writeText rejects after create", async () => {
    // The exact gap: `.catch(() => undefined)` discarded the rejection, then success still fired.
    mockClipboard(() => Promise.reject(new Error("denied")));
    render(<ExtensionTokenButton />);

    fireEvent.click(screen.getByRole("button", { name: "Create extension token" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Couldn't copy extension token", expect.any(Object)),
    );
    expect(success).not.toHaveBeenCalled();
    // Token must still render so the user can recover via the manual copy button.
    expect(screen.getByTestId("extension-token-value").textContent).toBe(TOKEN);
    expect(screen.getByRole("button", { name: "Copy extension token" })).toBeTruthy();
  });

  it("manual Copy button copies the displayed token and reports failure honestly", async () => {
    mockClipboard(() => Promise.resolve());
    render(<ExtensionTokenButton />);
    fireEvent.click(screen.getByRole("button", { name: "Create extension token" }));
    await waitFor(() => screen.getByRole("button", { name: "Copy extension token" }));
    vi.clearAllMocks();

    const writeText = mockClipboard(() => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Copy extension token" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Extension token copied", expect.any(Object)),
    );

    vi.clearAllMocks();
    mockClipboard(() => Promise.reject(new Error("denied")));
    fireEvent.click(screen.getByRole("button", { name: "Copy extension token" }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Couldn't copy extension token", expect.any(Object)),
    );
    expect(success).not.toHaveBeenCalled();
  });
});
