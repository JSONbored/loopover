import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { ReesAnalyzerFieldGroup } from "@/components/site/app-panels/rees-analyzer-field-group";
import type { GeneratorFormState } from "@/lib/config-generator-form-state";
import {
  effectiveReesAnalyzerEnabled,
  patchGeneratorReesAnalyzer,
  reesAnalyzersManifestPatch,
  resetGeneratorReesAnalyzers,
} from "@/lib/config-generator-form-state";
import { REES_ANALYZERS, REES_DEFAULT_PROFILE } from "@/lib/rees-analyzers";

const defaultOn = REES_ANALYZERS.find((analyzer) =>
  analyzer.profiles.includes(REES_DEFAULT_PROFILE),
)!;
const defaultOff = REES_ANALYZERS.find(
  (analyzer) => !analyzer.profiles.includes(REES_DEFAULT_PROFILE),
);

function Harness({ onState }: { onState: (state: GeneratorFormState) => void }) {
  const [state, setState] = useState<GeneratorFormState>({});
  return (
    <ReesAnalyzerFieldGroup
      state={state}
      onChange={(next) => {
        setState(next);
        onState(next);
      }}
    />
  );
}

describe("rees form-state helpers (#2207)", () => {
  it("resolves both arms of the default-vs-override branch", () => {
    // default arm: no override → profile membership decides
    expect(effectiveReesAnalyzerEnabled(undefined, defaultOn, REES_DEFAULT_PROFILE)).toBe(true);
    if (defaultOff) {
      expect(effectiveReesAnalyzerEnabled({}, defaultOff, REES_DEFAULT_PROFILE)).toBe(false);
    }
    // override arm: explicit value wins over the profile default
    const disabled = patchGeneratorReesAnalyzer({}, defaultOn.name, false);
    expect(effectiveReesAnalyzerEnabled(disabled.rees, defaultOn, REES_DEFAULT_PROFILE)).toBe(
      false,
    );
  });

  it("clears a single override via the null patch and all overrides via reset", () => {
    let state = patchGeneratorReesAnalyzer({}, defaultOn.name, false);
    state = patchGeneratorReesAnalyzer(state, defaultOn.name, null);
    expect(state.rees?.analyzers).toEqual({});
    state = patchGeneratorReesAnalyzer(state, defaultOn.name, false);
    expect(resetGeneratorReesAnalyzers(state).rees?.analyzers).toEqual({});
  });

  it("emits no manifest key without overrides, and the exact effective list with one", () => {
    expect(reesAnalyzersManifestPatch(undefined, REES_ANALYZERS, REES_DEFAULT_PROFILE)).toEqual({
      reesAnalyzers: null,
    });
    const state = patchGeneratorReesAnalyzer({}, defaultOn.name, false);
    const patch = reesAnalyzersManifestPatch(state.rees, REES_ANALYZERS, REES_DEFAULT_PROFILE);
    expect(patch.reesAnalyzers).not.toBeNull();
    expect(patch.reesAnalyzers).not.toContain(defaultOn.name);
    // every other default-profile analyzer is still present — exact-list semantics, not a delta
    for (const analyzer of REES_ANALYZERS) {
      if (analyzer.name === defaultOn.name) continue;
      expect(patch.reesAnalyzers!.includes(analyzer.name)).toBe(
        analyzer.profiles.includes(REES_DEFAULT_PROFILE),
      );
    }
  });

  it("enable-all: overriding every analyzer on yields the full catalog list", () => {
    let state: GeneratorFormState = {};
    for (const analyzer of REES_ANALYZERS) {
      state = patchGeneratorReesAnalyzer(state, analyzer.name, true);
    }
    expect(reesAnalyzersManifestPatch(state.rees, REES_ANALYZERS, REES_DEFAULT_PROFILE)).toEqual({
      reesAnalyzers: REES_ANALYZERS.map((analyzer) => analyzer.name),
    });
  });
});

describe("ReesAnalyzerFieldGroup (#2207)", () => {
  it("renders one labeled toggle per catalog analyzer with its name and summary", () => {
    render(<Harness onState={() => {}} />);
    for (const analyzer of REES_ANALYZERS) {
      expect(screen.getByRole("switch", { name: `Toggle ${analyzer.title}` })).toBeTruthy();
    }
    expect(screen.getByText(defaultOn.docs.summary)).toBeTruthy();
  });

  it("toggling one analyzer writes an override into the shared form state", () => {
    let latest: GeneratorFormState = {};
    render(<Harness onState={(state) => (latest = state)} />);
    const toggle = screen.getByRole("switch", { name: `Toggle ${defaultOn.title}` });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(latest.rees?.analyzers).toEqual({ [defaultOn.name]: false });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("override")).toBeTruthy();
  });

  it("reset-to-profile-default clears overrides and disables itself when there are none", () => {
    let latest: GeneratorFormState = {};
    render(<Harness onState={(state) => (latest = state)} />);
    const reset = screen.getByRole("button", {
      name: "Reset to profile default",
    }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: `Toggle ${defaultOn.title}` }));
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(latest.rees?.analyzers).toEqual({});
    expect(reset.disabled).toBe(true);
    expect(
      screen
        .getByRole("switch", { name: `Toggle ${defaultOn.title}` })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
