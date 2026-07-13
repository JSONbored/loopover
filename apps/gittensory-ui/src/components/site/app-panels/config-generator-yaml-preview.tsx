import { CodeBlock } from "@/components/site/primitives";
import { formStateToYaml, type GeneratorFormState } from "@/lib/config-generator-yaml";

/**
 * Read-only `.loopover.yml` preview for the config generator (#2210, part of #1683): renders the
 * current GeneratorFormState as text via CodeBlock (built-in copy-to-clipboard) so the output is
 * explicit and reviewable before a self-hoster saves or copies it. Purely presentational — field-group
 * panels own collecting the form state. The legacy `.gittensory.yml` filename works identically if a
 * self-hoster already has one committed (#4773) — this preview just names the new canonical filename.
 */
export function ConfigGeneratorYamlPreview({ formState }: { formState: GeneratorFormState }) {
  return (
    <section className="rounded-token border-hairline bg-card p-5">
      <h2 className="font-display text-token-lg font-semibold">Preview</h2>
      <p className="mt-1 text-token-xs text-muted-foreground">
        The exact <code className="font-mono">.loopover.yml</code> this configuration would produce
        (the legacy <code className="font-mono">.gittensory.yml</code> name also still works).
        Nothing is saved until you copy it into your repo.
      </p>
      <div className="mt-4">
        <CodeBlock code={formStateToYaml(formState)} filename=".loopover.yml" />
      </div>
    </section>
  );
}
