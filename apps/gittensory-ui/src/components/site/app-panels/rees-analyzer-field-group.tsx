import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { StateActionButton } from "@/components/site/state-views";
import type { GeneratorFormState } from "@/lib/config-generator-form-state";
import {
  effectiveReesAnalyzerEnabled,
  patchGeneratorReesAnalyzer,
  resetGeneratorReesAnalyzers,
} from "@/lib/config-generator-form-state";
import { REES_ANALYZERS, REES_DEFAULT_PROFILE } from "@/lib/rees-analyzers";

// Stable category order for the grouped list: catalog order of first appearance, so the section
// reads the same way the analyzer reference docs page does.
const CATEGORIES = REES_ANALYZERS.reduce<string[]>((order, analyzer) => {
  if (!order.includes(analyzer.category)) order.push(analyzer.category);
  return order;
}, []);

export function ReesAnalyzerFieldGroup({
  state,
  onChange,
}: {
  state: GeneratorFormState;
  onChange: (next: GeneratorFormState) => void;
}) {
  const overrides = state.rees?.analyzers ?? {};
  const overrideCount = Object.keys(overrides).length;

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="rees-analyzers-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="rees-analyzers-title" className="font-display text-token-lg font-semibold">
            REES analyzers
          </h2>
          <p className="max-w-2xl text-token-xs text-muted-foreground">
            Choose which enrichment analyzers run. Untouched analyzers follow the{" "}
            <code className="font-mono">{REES_DEFAULT_PROFILE}</code> profile default; changing any
            switch writes an exact analyzer list into the generated config (
            <code className="font-mono">REES_ANALYZERS</code> is an exact list, not a delta).
          </p>
        </div>
        <StateActionButton
          onClick={() => onChange(resetGeneratorReesAnalyzers(state))}
          disabled={overrideCount === 0}
        >
          Reset to profile default
        </StateActionButton>
      </div>

      <ScrollArea className="mt-5 h-96 rounded-token border-hairline bg-background/40">
        <div className="space-y-5 p-4">
          {CATEGORIES.map((category) => (
            <fieldset key={category}>
              <legend className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                {category}
              </legend>
              <ul className="mt-2 space-y-2">
                {REES_ANALYZERS.filter((analyzer) => analyzer.category === category).map(
                  (analyzer) => {
                    const enabled = effectiveReesAnalyzerEnabled(
                      state.rees,
                      analyzer,
                      REES_DEFAULT_PROFILE,
                    );
                    const overridden = analyzer.name in overrides;
                    return (
                      <li
                        key={analyzer.name}
                        className="flex items-start justify-between gap-3 rounded-token border border-border bg-background/40 p-3"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-token-sm font-medium text-foreground">
                              {analyzer.title}
                            </span>
                            <code className="font-mono text-token-2xs text-muted-foreground">
                              {analyzer.name}
                            </code>
                            {overridden && (
                              <span className="font-mono text-token-2xs uppercase tracking-wider text-mint">
                                override
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-token-xs text-muted-foreground">
                            {analyzer.docs.summary}
                          </p>
                        </div>
                        <Switch
                          checked={enabled}
                          onCheckedChange={(next) =>
                            onChange(patchGeneratorReesAnalyzer(state, analyzer.name, next))
                          }
                          aria-label={`Toggle ${analyzer.title}`}
                          className="mt-0.5 shrink-0"
                        />
                      </li>
                    );
                  },
                )}
              </ul>
            </fieldset>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
