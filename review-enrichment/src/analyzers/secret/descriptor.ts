import type { AnalyzerDescriptor } from "../types.js";
import { scanSecrets } from "../secret-scan.js";

export const secretAnalyzer: AnalyzerDescriptor<"secret"> = {
  name: "secret",
  title: "Hardcoded secrets",
  category: "security",
  cost: "local",
  defaultEnabled: true,
  requires: ["files"],
  docs: {
    summary: "Scans added diff lines for credential-shaped values.",
    looksAt: "Added lines in every changed file patch.",
    reports:
      "File, line, secret kind, and confidence. The matched value is never returned.",
    network: "Pure local analyzer. No external network call.",
    notes:
      "High-confidence patterns are treated as rotate-and-remove candidates; generic assignments stay verify-first.",
  },
  run: (req) => scanSecrets(req),
  render: (secrets, { safeCodeSpan }) => {
    const lines: string[] = [];
    if (!secrets.length) return lines;
    lines.push(
      "### Potential leaked secrets (value-redacted — verify + rotate)",
    );
    for (const secret of secrets) {
      lines.push(
        `- ${safeCodeSpan(`${secret.file}:${secret.line}`)} — ${secret.kind} (${secret.confidence} confidence)`,
      );
    }
    return lines;
  },
};
