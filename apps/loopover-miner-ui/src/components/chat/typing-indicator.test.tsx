import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TypingIndicator } from "./typing-indicator";

// Regression for #8303: the three animate-bounce dots must each pair their animation with
// motion-reduce:animate-none so a user with the OS "reduce motion" preference set sees a static indicator
// instead of a bouncing one -- matching the guard skeleton.tsx / Spinner already provide.
describe("TypingIndicator respects prefers-reduced-motion (#8303)", () => {
  it("renders three bouncing dots that each carry motion-reduce:animate-none", () => {
    const { container } = render(<TypingIndicator authorName="Assistant" />);
    const dots = container.querySelectorAll(".animate-bounce");
    expect(dots.length).toBe(3);
    for (const dot of dots) {
      expect(dot.className).toContain("motion-reduce:animate-none");
    }
  });

  it("renders nothing when not composing (unchanged behavior)", () => {
    const { container } = render(<TypingIndicator composing={false} />);
    expect(container.firstChild).toBeNull();
  });
});
