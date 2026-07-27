import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPredictedGateVerdict } from "../src/rules/predicted-gate";
import { predictedGateFixtures } from "../test/fixtures/engine-parity/predicted-gate/index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenDir = join(repoRoot, "test/fixtures/engine-parity/predicted-gate/golden");

mkdirSync(goldenDir, { recursive: true });

for (const fixture of predictedGateFixtures) {
  const verdict = buildPredictedGateVerdict({
    input: fixture.input,
    manifest: fixture.manifest,
    repo: fixture.repo,
    issues: fixture.issues,
    pullRequests: fixture.pullRequests,
    ...(fixture.changedPaths ? { changedPaths: fixture.changedPaths } : {}),
  });
  writeFileSync(join(goldenDir, `${fixture.id}.json`), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
}

process.stdout.write(`Recorded ${predictedGateFixtures.length} predicted-gate goldens in ${goldenDir}\n`);
