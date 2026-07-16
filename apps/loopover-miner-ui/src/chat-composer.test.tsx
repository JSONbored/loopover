import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatComposer } from "./components/chat-composer";

/** The cap the component enforces (chat-composer.tsx's MAX_COMPOSER_HEIGHT_PX). */
const MAX_HEIGHT_PX = 160;

function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<ChatComposer onSubmit={onSubmit} {...props} />);
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  return { onSubmit, textarea, button: screen.getByRole("button", { name: /send/i }) };
}

/** jsdom computes no layout, so a rendered textarea's scrollHeight is always 0. Stub it, then fire the input
 *  event the component measures on -- asserting a real pixel height here would be asserting nothing. */
function typeWithScrollHeight(textarea: HTMLTextAreaElement, value: string, scrollHeight: number) {
  Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: scrollHeight });
  fireEvent.change(textarea, { target: { value } });
}

describe("ChatComposer submit paths (#6514)", () => {
  it("Enter with no modifier submits the trimmed message and clears the box", () => {
    const { onSubmit, textarea } = setup();
    fireEvent.change(textarea, { target: { value: "  how is the queue?  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("how is the queue?");
    expect(textarea.value).toBe("");
  });

  it("Shift+Enter inserts a newline and does NOT submit", () => {
    const { onSubmit, textarea } = setup();
    fireEvent.change(textarea, { target: { value: "first line" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    // The default isn't prevented, so the browser's own newline insertion still happens.
    expect(textarea.value).toBe("first line");
  });

  it("clicking Send submits identically to Enter", () => {
    const { onSubmit, textarea, button } = setup();
    fireEvent.change(textarea, { target: { value: "  release the queue  " } });
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith("release the queue");
    expect(textarea.value).toBe("");
  });

  it("blocks an empty and a whitespace-only message on BOTH the Enter and the click path", () => {
    const { onSubmit, textarea, button } = setup();
    // Nothing typed at all.
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.click(button);
    // Whitespace only -- must be blocked exactly like "" (the guard trims first).
    fireEvent.change(textarea, { target: { value: "     " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    // A blocked submit must not silently eat the draft either.
    expect(textarea.value).toBe("     ");
  });

  it("a non-Enter key never submits", () => {
    const { onSubmit, textarea } = setup();
    fireEvent.change(textarea, { target: { value: "typing" } });
    fireEvent.keyDown(textarea, { key: "a" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a modifier+Enter chord does not submit a half-written message", () => {
    const { onSubmit, textarea } = setup();
    fireEvent.change(textarea, { target: { value: "half written" } });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      fireEvent.keyDown(textarea, { key: "Enter", ...modifier });
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ChatComposer auto-grow (#6514)", () => {
  it("grows to fit content while below the cap", () => {
    const { textarea } = setup();
    typeWithScrollHeight(textarea, "one\ntwo\nthree", 90);
    expect(textarea.style.height).toBe("90px");
    // Below the cap there is nothing to scroll, so no scrollbar is offered.
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("stops growing at the cap and scrolls internally instead", () => {
    const { textarea } = setup();
    typeWithScrollHeight(textarea, "a very tall pasted block", 400);
    expect(textarea.style.height).toBe(`${MAX_HEIGHT_PX}px`);
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("shrinks back when content is deleted", () => {
    const { textarea } = setup();
    typeWithScrollHeight(textarea, "one\ntwo\nthree", 90);
    expect(textarea.style.height).toBe("90px");
    // Deleting lines must shrink the box -- it only can because the component collapses the height before
    // re-measuring, otherwise scrollHeight would still report the taller previous box.
    typeWithScrollHeight(textarea, "one", 30);
    expect(textarea.style.height).toBe("30px");
  });

  it("settles the height back down after a submit clears the box", () => {
    const { textarea } = setup();
    typeWithScrollHeight(textarea, "a\nb\nc", 90);
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 30 });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("");
    expect(textarea.style.height).toBe("30px");
  });
});

describe("ChatComposer presentational props (#6514)", () => {
  it("renders the default placeholder and accepts an override", () => {
    const { textarea } = setup();
    expect(textarea.placeholder).toBe("Ask about this miner…");
    screen.getByRole("textbox");
    render(<ChatComposer onSubmit={vi.fn()} placeholder="Ask anything" />);
    expect(screen.getAllByRole("textbox")[1]!.getAttribute("placeholder")).toBe("Ask anything");
  });

  it("disables both controls when disabled", () => {
    const { textarea, button } = setup({ disabled: true });
    expect(textarea.disabled).toBe(true);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
