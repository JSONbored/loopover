/** Shared manifest for the self-host docs accuracy audit (#1829). Imported by the docs page and CI drift tests. */

export type SelfHostDocsPageLink = {
  title: string;
  path: string;
  /** The page's real source since the #8182 dynamic-route migration: content/docs/<slug>.mdx (the
   *  one docs.$slug.tsx route serves every page — there is no per-page .tsx to point at anymore). */
  contentFile: string;
};

export const SELFHOST_DOCS_PAGES = [
  {
    title: "Quickstart",
    path: "/docs/self-hosting-quickstart",
    contentFile: "self-hosting-quickstart.mdx",
  },
  {
    title: "Configuration",
    path: "/docs/self-hosting-configuration",
    contentFile: "self-hosting-configuration.mdx",
  },
  {
    title: "GitHub App and Orb",
    path: "/docs/self-hosting-github-app",
    contentFile: "self-hosting-github-app.mdx",
  },
  {
    title: "AI providers",
    path: "/docs/self-hosting-ai-providers",
    contentFile: "self-hosting-ai-providers.mdx",
  },
  {
    title: "REES enrichment",
    path: "/docs/self-hosting-rees",
    contentFile: "self-hosting-rees.mdx",
  },
  {
    title: "REES analyzer reference",
    path: "/docs/self-hosting-rees-analyzers",
    contentFile: "self-hosting-rees-analyzers.mdx",
  },
  { title: "RAG indexing", path: "/docs/self-hosting-rag", contentFile: "self-hosting-rag.mdx" },
  {
    title: "Operations",
    path: "/docs/self-hosting-operations",
    contentFile: "self-hosting-operations.mdx",
  },
  {
    title: "Backup and scaling",
    path: "/docs/self-hosting-backup-scaling",
    contentFile: "self-hosting-backup-scaling.mdx",
  },
  {
    title: "Releases and images",
    path: "/docs/self-hosting-releases",
    contentFile: "self-hosting-releases.mdx",
  },
  {
    title: "Release checklist",
    path: "/docs/self-hosting-release-checklist",
    contentFile: "self-hosting-release-checklist.mdx",
  },
  {
    title: "Security",
    path: "/docs/self-hosting-security",
    contentFile: "self-hosting-security.mdx",
  },
  {
    title: "Troubleshooting",
    path: "/docs/self-hosting-troubleshooting",
    contentFile: "self-hosting-troubleshooting.mdx",
  },
  {
    title: "Docs accuracy audit",
    path: "/docs/self-hosting-docs-audit",
    contentFile: "self-hosting-docs-audit.mdx",
  },
] as const;

export type SelfHostDocsPath = (typeof SELFHOST_DOCS_PAGES)[number]["path"];

export type SelfHostSourceOfTruthRow = {
  topic: string;
  runtimeSources: readonly string[];
  docsPath: SelfHostDocsPath;
  driftGuard?: string;
  notes?: string;
};

export type LooseDocsRow = {
  path: string;
  role: string;
  action: "keep" | "link-only" | "consolidated";
  websiteDocsPath?: SelfHostDocsPath;
  notes?: string;
};

export const SELFHOST_SOURCE_OF_TRUTH_ROWS: readonly SelfHostSourceOfTruthRow[] = [
  {
    topic: "Compose stack and profiles",
    runtimeSources: ["docker-compose.yml", ".env.selfhost.example", ".env.example"],
    docsPath: "/docs/self-hosting-quickstart",
    notes: "Profiles (postgres, rees, observability, backup) and conservative first-boot defaults.",
  },
  {
    topic: "Env vars (exhaustive list)",
    runtimeSources: [
      "scripts/gen-selfhost-env-reference.ts",
      "apps/loopover-ui/src/lib/selfhost-env-reference.ts",
    ],
    docsPath: "/docs/self-hosting-configuration",
    driftGuard: "selfhost-env-reference-script.test.ts",
    notes: "Generated from every env.SOMETHING read; npm run selfhost:env-reference:check in CI.",
  },
  {
    topic: "GitHub App manifest and setup wizard",
    runtimeSources: ["src/selfhost/setup-wizard.ts", ".env.selfhost.example"],
    docsPath: "/docs/self-hosting-github-app",
    driftGuard: "setup-wizard-docs-parity.test.ts",
  },
  {
    topic: "Activation and onboarding paths",
    runtimeSources: ["src/server.ts", "config/examples/global.loopover.yml"],
    docsPath: "/docs/self-hosting-configuration",
    driftGuard: "docs-selfhost-activation-paths.test.ts",
  },
  {
    topic: "AI providers and unsafe Codex opt-in",
    runtimeSources: ["src/selfhost/ai-config.ts", "src/selfhost/ai.ts"],
    docsPath: "/docs/self-hosting-ai-providers",
    notes: "Codex PR review is fail-closed unless LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER=1.",
  },
  {
    topic: "REES sidecar (compose profile)",
    runtimeSources: ["docker-compose.yml", "review-enrichment/Dockerfile"],
    docsPath: "/docs/self-hosting-rees",
    notes:
      "Analyzer metadata tables live on the REES analyzer page; generation is a separate roadmap item.",
  },
  {
    topic: "RAG / embeddings / Qdrant",
    runtimeSources: ["src/selfhost/qdrant-vectorize.ts", "docker-compose.yml"],
    docsPath: "/docs/self-hosting-rag",
  },
  {
    topic: "Update, rollback, and deploy scripts",
    runtimeSources: [
      "scripts/deploy-selfhost-image.sh",
      "scripts/deploy-selfhost-prebuilt.sh",
      "scripts/selfhost-post-update-check.sh",
    ],
    docsPath: "/docs/self-hosting-operations",
    driftGuard: "docs-selfhost-update-rollback.test.ts",
    notes: "Migrations are forward-only; rollback is image-only.",
  },
  {
    topic: "Runner temp storage (multi-runner)",
    runtimeSources: ["docker-compose.yml"],
    docsPath: "/docs/self-hosting-operations",
    driftGuard: "docs-selfhost-operations-runner-tmpdir.test.ts",
  },
  {
    topic: "Backup, restore, and Litestream",
    runtimeSources: ["scripts/backup.sh", "scripts/verify-backup.sh", "scripts/backup-metrics.sh"],
    docsPath: "/docs/self-hosting-backup-scaling",
    driftGuard: "selfhost-backup-script.test.ts",
  },
  {
    topic: "Official orb-v* releases and GHCR tags",
    runtimeSources: [".github/workflows/release-selfhost.yml", "Dockerfile"],
    docsPath: "/docs/self-hosting-releases",
    notes:
      "Release workflow uploads source maps to Sentry; maps never ship inside the runtime image.",
  },
  {
    topic: "Release smoke matrix and image-contents audit",
    runtimeSources: ["scripts/smoke-selfhost.sh", "Dockerfile", ".dockerignore"],
    docsPath: "/docs/self-hosting-release-checklist",
    driftGuard: "docs-selfhost-release-checklist-event-names.test.ts",
  },
  {
    topic: "Sentry (opt-in, operator-owned DSN)",
    runtimeSources: ["src/selfhost/sentry.ts", "docker-compose.yml"],
    docsPath: "/docs/self-hosting-operations",
    driftGuard: "docs-selfhost-sentry-observability.test.ts",
    notes: "Sentry is off by default until SENTRY_DSN or SENTRY_DSN_FILE is set.",
  },
  {
    topic: "OTEL metrics/traces and Grafana dashboards",
    runtimeSources: [
      "src/selfhost/otel.ts",
      "scripts/validate-observability-configs.ts",
      "grafana/dashboards/",
      "prometheus/rules/alerts.yml",
    ],
    docsPath: "/docs/self-hosting-operations",
    driftGuard: "docs-selfhost-troubleshooting-metric-names.test.ts",
    notes: "Observability profile is optional; npm run selfhost:validate-observability in CI.",
  },
  {
    topic: "Security boundaries and secret handling",
    runtimeSources: ["src/selfhost/private-config.ts", "src/selfhost/preflight.ts"],
    docsPath: "/docs/self-hosting-security",
  },
  {
    topic: "Prometheus alert runbooks",
    runtimeSources: ["prometheus/rules/alerts.yml", "src/selfhost/metrics.ts"],
    docsPath: "/docs/self-hosting-troubleshooting",
    driftGuard: "docs-selfhost-troubleshooting-metric-names.test.ts",
  },
] as const;

export const LOOSE_DOCS_ROWS: readonly LooseDocsRow[] = [
  {
    path: "CONVERGENCE_RUNBOOK.md",
    role: "Native-port convergence and hosted Cloudflare inventory (#1030 / #1826).",
    action: "keep",
    notes: "Intentional root runbook — not a duplicate of the website self-host section.",
  },
  {
    path: "config/examples/README.md",
    role: "Private config mount examples and template pointers.",
    action: "link-only",
    websiteDocsPath: "/docs/self-hosting-configuration",
  },
  {
    path: "review-enrichment/README.md",
    role: "REES analyzer developer notes for contributors.",
    action: "link-only",
    websiteDocsPath: "/docs/self-hosting-rees",
  },
  {
    path: "packages/loopover-miner/DEPLOYMENT.md",
    role: "Miner CLI deployment — explicitly not the self-host review stack.",
    action: "keep",
    notes:
      "Also published at /docs/ams-deployment (#6022) for website discoverability; this file stays the canonical source since it ships inside the published @loopover/miner package.",
  },
] as const;

export const SELFHOST_DOCS_VALIDATION_COMMANDS = [
  "npm run docs:drift-check",
  "npm run selfhost:env-reference:check",
  "npm run selfhost:validate-observability",
  "npm run ui:lint",
  "npm run ui:typecheck",
  "npm run ui:test",
  "npm run ui:build",
  "npm run test:ci",
] as const;
