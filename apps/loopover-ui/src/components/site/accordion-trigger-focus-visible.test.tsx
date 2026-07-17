import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@loopover/ui-kit/components/accordion";

// #7015: every other styled interactive trigger in ui-kit (button, tabs, toggle, switch, checkbox, slider)
// applies a focus-visible:ring-* class; AccordionTrigger was the one that didn't, leaving keyboard users with
// no visible indication of focus when tabbing to an accordion header.
describe("AccordionTrigger focus-visible indicator (#7015)", () => {
  it("pairs the trigger with the kit's standard focus-visible ring classes", () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="item-1">
          <AccordionTrigger>Section</AccordionTrigger>
          <AccordionContent>Details</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    const trigger = screen.getByRole("button", { name: "Section" });
    expect(trigger.className).toContain("focus-visible:outline-none");
    expect(trigger.className).toContain("focus-visible:ring-2");
    expect(trigger.className).toContain("focus-visible:ring-ring");
    expect(trigger.className).toContain("focus-visible:ring-offset-2");
  });
});
