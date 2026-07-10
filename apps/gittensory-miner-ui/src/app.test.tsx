import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IndexPage } from "./routes/index";

describe("miner ui shell", () => {
  it("renders the empty dashboard overview copy", () => {
    render(<IndexPage />);
    expect(screen.getByRole("heading", { name: "Dashboard shell ready" })).toBeTruthy();
    expect(screen.getByText(/Run-history and portfolio views/i)).toBeTruthy();
  });
});
