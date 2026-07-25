// Preloaded via --require before node:test loads review-enrichment's test files.
// c8 (the parent process) must keep its own cwd at the monorepo root so lcov SF: paths
// remap to `review-enrichment/src/**` for Codecov (#6250); this only chdir's the spawned
// test child, so tests that read fixtures with bare relative paths (e.g. "analyzer-metadata.json")
// resolve them against review-enrichment/, matching `npm run test:node`.
const { join } = require("node:path");

process.chdir(join(__dirname, "..", "review-enrichment"));
