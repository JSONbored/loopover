import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { navigationMenuTriggerStyle } from "./navigation-menu";
import { Select, SelectTrigger, SelectValue } from "./select";

// Regression for #8304: SelectTrigger, the Dialog/Sheet close buttons, and NavigationMenuTrigger must
// apply their focus ring/highlight via `focus-visible:` (keyboard/programmatic focus only), matching
// every other interactive primitive in @loopover/ui-kit — never on plain `focus:`, which also fires on
// mouse-click focus and leaves a lingering ring/highlight. `focus:outline-none` is intentionally kept
// (clearing the native outline on any focus is correct and shared by every primitive).
describe("focus-visible convention (#8304)", () => {
  it("navigationMenuTriggerStyle highlights on focus-visible, never a bare focus:bg-accent", () => {
    const classes = navigationMenuTriggerStyle();
    expect(classes).toContain("focus-visible:bg-accent");
    expect(classes).toContain("focus-visible:text-accent-foreground");
    // No bare focus:bg-accent / focus:text-accent-foreground (the data-[state=open]:focus:bg-accent
    // compound is a separate, intentional open-state rule and is allowed).
    expect(classes).not.toMatch(/(?<!:)\bfocus:bg-accent\b/);
    expect(classes).not.toMatch(/(?<!:)\bfocus:text-accent-foreground\b/);
    // The native-outline clear stays on plain focus:.
    expect(classes).toContain("focus:outline-none");
  });

  it("SelectTrigger rings on focus-visible, never a bare focus:ring", () => {
    const { getByRole } = render(
      <Select>
        <SelectTrigger aria-label="pick">
          <SelectValue placeholder="pick" />
        </SelectTrigger>
      </Select>,
    );
    const trigger = getByRole("combobox");
    expect(trigger.className).toContain("focus-visible:ring-1");
    expect(trigger.className).toContain("focus-visible:ring-ring");
    expect(trigger.className).not.toMatch(/(?<!-)\bfocus:ring/);
    expect(trigger.className).toContain("focus:outline-none");
  });
});
