import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderInline } from "./commands-panel";

function renderLine(line: string) {
  return render(<>{renderInline(line)}</>);
}

describe("renderInline (#7531)", () => {
  it("still renders **bold** as <strong> and `code` as <code>", () => {
    const { container } = renderLine("a **bold** and `code` here");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("still renders a whitespace-flanked _italic_ span as <em>", () => {
    const { container } = renderLine("an _emphasized_ word");
    expect(container.querySelector("em")?.textContent).toBe("emphasized");
    // At line start/end too.
    expect(renderLine("_lead_ then").container.querySelector("em")?.textContent).toBe("lead");
  });

  it("leaves underscore-heavy identifiers intact with no spurious <em>", () => {
    const { container } = renderLine(
      "set LOOPOVER_ENABLE_PAGERDUTY and repo_full_name to slop_gate_min_score",
    );
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe(
      "set LOOPOVER_ENABLE_PAGERDUTY and repo_full_name to slop_gate_min_score",
    );
  });

  it("does not italicize a digit-flanked underscore run either", () => {
    const { container } = renderLine("v2_beta_channel stays literal");
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("v2_beta_channel stays literal");
  });
});
