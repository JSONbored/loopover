#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const targets = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", "packages/gittensory-mcp/README.md", "site"];
const staleRoutes = [
  "/v1/contributors/:login/opportunities",
  "/v1/contributors/:login/fit",
  "/v1/contributors/:login/strategy",
  "/v1/contributors/:login/reward-risk-strategy",
  "/v1/repos/:owner/:repo/queue-health",
  "/v1/repos/:owner/:repo/collisions",
  "/v1/repos/:owner/:repo/config-quality",
  "/v1/repos/:owner/:repo/labels/audit",
];

const forbidden = [
  { name: "local macOS home path", pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "dev vars assignment", pattern: /^GITHUB_(?:WEBHOOK_SECRET|APP_PRIVATE_KEY|PUBLIC_TOKEN)=.+$/m },
  { name: "gittensory token assignment", pattern: /^GITTENSORY_(?:API_TOKEN|MCP_TOKEN|TOKEN)=.+$/m },
  { name: "internal token assignment", pattern: /^INTERNAL_JOB_TOKEN=.+$/m },
  { name: "stale private-beta wording", pattern: /\bprivate beta\b/i },
  { name: "preview worker domain", pattern: /zeronode\.workers\.dev/i },
];

const files = targets.flatMap((target) => collect(join(root, target))).filter((file) => /\.(md|mts|ts|js|json|yml)$/.test(file));
const failures = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const label = file.slice(root.length + 1);
  for (const route of staleRoutes) {
    if (text.includes(route)) failures.push(`${label}: stale route ${route}`);
  }
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) failures.push(`${label}: ${rule.name}`);
  }
}

const siteIndex = readFileSync(join(root, "site/index.md"), "utf8");
for (const phrase of ["Gittensor miners", "GitHub App", "MCP", "not a Gittensor frontend"]) {
  if (!siteIndex.includes(phrase)) failures.push(`site/index.md: missing required positioning phrase ${JSON.stringify(phrase)}`);
}
if (!siteIndex.includes("/images/gittensor-home-signal.webp")) {
  failures.push("site/index.md: missing Gittensor context image reference");
}
if (!existsSync(join(root, "site/public/images/gittensor-home-signal.webp"))) {
  failures.push("site/public/images/gittensor-home-signal.webp: missing Gittensor context image asset");
}

for (const required of ["SUPPORT.md", "site/security/privacy.md", "site/security/terms.md", "site/support.md"]) {
  try {
    readFileSync(join(root, required), "utf8");
  } catch {
    failures.push(`${required}: missing public-registration support/privacy/terms doc`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`checked ${files.length} docs file(s)`);

function collect(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) => {
    const next = join(path, entry);
    if (entry === "node_modules" || next.includes("site/.vitepress/cache") || next.includes("site/.vitepress/dist")) return [];
    return collect(next);
  });
}
