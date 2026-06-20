import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResponsiveDataTable } from "@/components/site/responsive-data-table";

type Row = { id: string; name: string };

describe("ResponsiveDataTable", () => {
  it("renders desktop table headers and mobile definition lists", () => {
    render(
      <ResponsiveDataTable<Row>
        caption="Sample queue"
        rows={[{ id: "1", name: "Alpha" }]}
        rowKey={(row) => row.id}
        columns={[
          { id: "id", header: "ID", cell: (row) => row.id },
          { id: "name", header: "Name", cell: (row) => row.name },
        ]}
      />,
    );

    expect(screen.getAllByText("ID").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Sample queue" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Sample queue" })).toBeTruthy();
  });

  it("shows an empty message when there are no rows", () => {
    render(
      <ResponsiveDataTable<Row>
        caption="Empty queue"
        rows={[]}
        rowKey={(row) => row.id}
        emptyMessage="Nothing queued yet."
        columns={[{ id: "id", header: "ID", cell: (row) => row.id }]}
      />,
    );

    expect(screen.getByText("Nothing queued yet.")).toBeTruthy();
  });
});
