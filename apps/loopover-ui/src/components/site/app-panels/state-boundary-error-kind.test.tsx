import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// #6176: useApiResource has always exposed errorKind on its error state, and ErrorState has always used it to
// show connectivity-specific copy (state-views.test.tsx pins that consumer). The missing link was the panels
// themselves, which never forwarded the field -- so a pure network failure rendered the generic "Couldn't load
// this" everywhere except app.runs.tsx. These tests pin the wiring: a network-kind failure must now surface the
// connectivity copy through the panel, and a server-side failure must still get the generic copy.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({ useApiResource: () => useApiResource() }));

import { CommandsPanel } from "@/components/site/app-panels/commands-panel";
import { DigestPanel } from "@/components/site/app-panels/digest-panel";

// StateBoundary keeps its own pre-#793 default title for a non-network failure, and passes `undefined` for a
// network one so ErrorState's connectivity-aware default shows through instead. Forwarding errorKind is what
// selects between the two, so these are the exact strings the fix moves between.
const NETWORK_COPY = "Can't reach the server";
const GENERIC_COPY = "Couldn't load data";

function errorState(errorKind?: string) {
  return {
    status: "error",
    data: null,
    error: "boom",
    errorKind,
    loadedAt: null,
    reload: () => {},
  };
}

const PANELS = [
  { name: "DigestPanel", render: () => render(<DigestPanel />) },
  { name: "CommandsPanel", render: () => render(<CommandsPanel />) },
] as const;

describe("StateBoundary errorKind forwarding (#6176)", () => {
  for (const panel of PANELS) {
    it(`${panel.name} shows connectivity copy when the fetch failed with a network kind`, () => {
      useApiResource.mockReturnValue(errorState("network"));
      panel.render();
      expect(screen.getByText(NETWORK_COPY)).toBeTruthy();
    });

    it(`${panel.name} still shows the generic copy for a server-side failure`, () => {
      // The point of forwarding the kind is that it DISTINGUISHES the two -- an API error must not start
      // claiming the server is unreachable.
      useApiResource.mockReturnValue(errorState("http"));
      panel.render();
      expect(screen.getByText(GENERIC_COPY)).toBeTruthy();
      expect(screen.queryByText(NETWORK_COPY)).toBeNull();
    });
  }
});
