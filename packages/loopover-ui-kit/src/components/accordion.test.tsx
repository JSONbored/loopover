import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion";

// Regression for #8303: the Radix content/transition components in @loopover/ui-kit must pair their
// animate-* utilities with motion-reduce:animate-none, matching skeleton.tsx / state-views.tsx, so a user
// with the OS "reduce motion" preference set does not get the fade/zoom/slide/accordion animation.
// AccordionContent is a representative Radix content component (its animate-accordion-up/down utilities are
// the ones the issue calls out) and renders inline when its item is open.
describe("AccordionContent respects prefers-reduced-motion (#8303)", () => {
  it("carries motion-reduce:animate-none alongside its animate-accordion utilities", () => {
    const { getByText } = render(
      <Accordion type="single" defaultValue="a" collapsible>
        <AccordionItem value="a">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Body</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    // The Radix Content wraps the inner padding div that holds the text.
    const content = getByText("Body").parentElement as HTMLElement;
    expect(content.className).toContain(
      "data-[state=open]:animate-accordion-down",
    );
    expect(content.className).toContain("motion-reduce:animate-none");
  });
});
