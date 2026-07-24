import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, useSidebar } from "./sidebar";

// jsdom implements no window.matchMedia; SidebarProvider pulls it in via useIsMobile. Stub it desktop-shaped
// (matches:false), the standard shadcn use-mobile test setup.
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

// #8305: SidebarProvider's global Cmd/Ctrl+B keydown handler used to toggle the sidebar (and preventDefault())
// no matter what had focus — hijacking the browser-native Bold shortcut inside text fields. These pin the
// isTyping() guard: the shortcut still works from non-editable targets, and is inert inside a form field or
// contenteditable element (target's own text-editing keeps the native behavior).

function StateProbe() {
  const { open } = useSidebar();
  return <span data-testid="sidebar-open">{open ? "open" : "closed"}</span>;
}

function setup() {
  const utils = render(
    <SidebarProvider>
      <StateProbe />
      <input data-testid="field-input" />
      <textarea data-testid="field-textarea" />
      <div data-testid="field-editable" />
    </SidebarProvider>,
  );
  // jsdom does not derive `isContentEditable` from the contentEditable attribute, so define it explicitly to
  // represent a real contenteditable element the way a browser reports it to the guard.
  const editable = screen.getByTestId("field-editable");
  Object.defineProperty(editable, "isContentEditable", {
    value: true,
    configurable: true,
  });
  return utils;
}

const openState = () => screen.getByTestId("sidebar-open").textContent;

describe("SidebarProvider Cmd/Ctrl+B guard (#8305)", () => {
  it("toggles the sidebar on Cmd/Ctrl+B from a non-editable target and prevents the default", () => {
    setup();
    const before = openState();
    // fireEvent returns false when the event's default was prevented.
    const notPrevented = fireEvent.keyDown(document.body, {
      key: "b",
      ctrlKey: true,
    });
    expect(notPrevented).toBe(false); // preventDefault() ran
    expect(openState()).not.toBe(before); // state flipped
  });

  it("does not toggle and does not preventDefault when the target is an input/textarea/contenteditable", () => {
    setup();
    for (const id of ["field-input", "field-textarea", "field-editable"]) {
      const before = openState();
      const notPrevented = fireEvent.keyDown(screen.getByTestId(id), {
        key: "b",
        metaKey: true,
      });
      expect(notPrevented, id).toBe(true); // default NOT prevented — native Bold survives
      expect(openState(), id).toBe(before); // sidebar unchanged
    }
  });

  it("leaves an unrelated Cmd/Ctrl chord (not 'b') alone", () => {
    setup();
    const before = openState();
    const notPrevented = fireEvent.keyDown(document.body, {
      key: "k",
      ctrlKey: true,
    });
    expect(notPrevented).toBe(true);
    expect(openState()).toBe(before);
  });
});
