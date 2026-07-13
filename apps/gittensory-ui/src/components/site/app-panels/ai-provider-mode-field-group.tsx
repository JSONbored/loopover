import { Callout } from "@/components/site/primitives";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type {
  AiCombineStrategy,
  AiProvider,
  GeneratorFormState,
  GeneratorGateAiReviewState,
} from "@/lib/config-generator-form-state";
import { patchGeneratorGateAiReview } from "@/lib/config-generator-form-state";
import { cn } from "@/lib/utils";

const COMBINE_OPTIONS: Array<{ value: AiCombineStrategy; title: string; description: string }> = [
  {
    value: "single",
    title: "single",
    description: "One reviewer verdict. Default for one provider or a fallback chain.",
  },
  {
    value: "consensus",
    title: "consensus",
    description: "Block only when both reviewers flag a critical defect.",
  },
  {
    value: "synthesis",
    title: "synthesis",
    description: "Both reviewers run, then one merged decision is produced.",
  },
];

const fieldClass =
  "mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint";
const labelClass = "font-mono text-token-2xs uppercase tracking-wider text-muted-foreground";

export function AiProviderModeFieldGroup({
  state,
  onChange,
}: {
  state: GeneratorFormState;
  onChange: (next: GeneratorFormState) => void;
}) {
  const aiReview = state.gate?.aiReview ?? {};
  const combine = aiReview.combine ?? "single";
  const provider = aiReview.provider ?? "anthropic";
  const model = aiReview.model ?? "";

  function patch(patch: Partial<GeneratorGateAiReviewState>) {
    onChange(patchGeneratorGateAiReview(state, patch));
  }

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="ai-provider-mode-title"
    >
      <div className="space-y-1">
        <h2 id="ai-provider-mode-title" className="font-display text-token-lg font-semibold">
          AI provider mode
        </h2>
        <p className="text-token-xs text-muted-foreground">
          Choose how dual-model review decisions are combined and which provider/model names to
          write into <code className="font-mono">gate.aiReview</code> in your generated config.
        </p>
      </div>

      <div className="mt-4">
        <Callout variant="safety" title="API keys stay out of this form">
          Provider API keys are configured via environment variables, encrypted key storage, or the
          maintainer BYOK dashboard — never in generated{" "}
          <code className="font-mono">.loopover.yml</code> files. This field group only records mode
          and model <em>names</em>.
        </Callout>
      </div>

      <div className="mt-5 space-y-5">
        <fieldset>
          <legend className={labelClass}>Combine strategy</legend>
          <RadioGroup
            className="mt-3 grid gap-3"
            value={combine}
            onValueChange={(value) => patch({ combine: value as AiCombineStrategy })}
          >
            {COMBINE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-token border border-border bg-background/40 p-3 transition-colors",
                  combine === option.value && "border-mint/40 bg-mint/5",
                )}
              >
                <RadioGroupItem value={option.value} aria-label={option.title} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block font-mono text-token-sm font-medium text-foreground">
                    {option.title}
                  </span>
                  <span className="mt-1 block text-token-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block" htmlFor="ai-provider-mode-provider">
            <span className={labelClass}>Provider</span>
            <select
              id="ai-provider-mode-provider"
              value={provider}
              onChange={(event) => patch({ provider: event.target.value as AiProvider })}
              className={fieldClass}
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (GPT)</option>
            </select>
          </label>
          <label className="block" htmlFor="ai-provider-mode-model">
            <span className={labelClass}>Model (optional)</span>
            <input
              id="ai-provider-mode-model"
              value={model}
              onChange={(event) => patch({ model: event.target.value })}
              placeholder="default"
              className={fieldClass}
            />
          </label>
        </div>
      </div>
    </section>
  );
}
