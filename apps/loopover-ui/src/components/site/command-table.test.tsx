import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CommandTable } from "@/components/site/command-table";

// #6986: pinned after migrating the hand-rolled <table> markup onto the shared Table primitive --
// confirms the real table structure, columns, and default-role lookup still render correctly.
describe("CommandTable", () => {
  it("renders a real <table> with the syntax/effect/default-roles columns and one row per entry", () => {
    render(
      <CommandTable
        title="Commands"
        entries={[
          { id: "review", title: "Review", description: "Runs a review pass." },
          {
            id: "unlisted-command",
            title: "Unlisted",
            description: "Not in the role summary map.",
          },
        ]}
      />,
    );

    const table = screen.getByRole("table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["Syntax", "Effect", "Default roles"]);

    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3); // header row + 2 entries

    expect(within(rows[1]!).getByText("@loopover review")).toBeTruthy();
    expect(within(rows[1]!).getByText("Runs a review pass.")).toBeTruthy();
    expect(within(rows[1]!).getByText("maintainer, collaborator, confirmed_miner")).toBeTruthy();

    // Falls back to "see policy" when the entry id has no DEFAULT_ROLE_SUMMARY mapping.
    expect(within(rows[2]!).getByText("@loopover unlisted-command")).toBeTruthy();
    expect(within(rows[2]!).getByText("see policy")).toBeTruthy();
  });

  it("renders the title heading", () => {
    render(<CommandTable title="Commands reference" entries={[]} />);
    expect(screen.getByRole("heading", { name: "Commands reference" })).toBeTruthy();
  });
});
