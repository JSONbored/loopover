import { defineConfig, type HeadConfig } from "vitepress";

const siteUrl = process.env.GITTENSORY_SITE_URL ?? "https://gittensory.aethereal.dev/";
const siteBase = process.env.GITTENSORY_SITE_BASE ?? "/";
const umamiScriptUrl = process.env.GITTENSORY_UMAMI_SCRIPT_URL;
const umamiWebsiteId = process.env.GITTENSORY_UMAMI_WEBSITE_ID;
const umamiDomains = process.env.GITTENSORY_UMAMI_DOMAINS ?? "gittensory.aethereal.dev";

const analyticsHead: HeadConfig[] = umamiScriptUrl && umamiWebsiteId
  ? [
      [
        "script",
        {
          defer: "",
          src: umamiScriptUrl,
          "data-website-id": umamiWebsiteId,
          "data-domains": umamiDomains,
          "data-do-not-track": "true",
          "data-exclude-search": "true",
          "data-exclude-hash": "true",
        },
      ],
    ]
  : [];

export default defineConfig({
  title: "Gittensory",
  description: "MCP and GitHub App decision intelligence for Gittensor contributors and maintainers.",
  base: siteBase,
  cleanUrls: true,
  lastUpdated: true,
  appearance: false,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    ["link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" }],
    ["meta", { property: "og:title", content: "Gittensory" }],
    ["meta", { property: "og:description", content: "Score blockers, lane fit, queue pressure, and reviewability context for Gittensor work." }],
    ["meta", { property: "og:url", content: siteUrl }],
    ["meta", { name: "theme-color", content: "#050608" }],
    ...analyticsHead,
  ],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      {
        text: "Start",
        items: [
          { text: "Install", link: "/guide/install" },
          { text: "Auth", link: "/guide/auth" },
          { text: "MCP Clients", link: "/guide/mcp" },
        ],
      },
      {
        text: "Workflows",
        items: [
          { text: "For Miners", link: "/guide/miners" },
          { text: "For Maintainers", link: "/guide/maintainers" },
          { text: "GitHub App Setup", link: "/guide/github-app-setup" },
        ],
      },
      { text: "API", link: "/reference/api" },
      {
        text: "Safety",
        items: [
          { text: "Privacy", link: "/security/privacy" },
          { text: "Terms", link: "/security/terms" },
          { text: "Support", link: "/support" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Install", link: "/guide/install" },
          { text: "Auth", link: "/guide/auth" },
          { text: "MCP Clients", link: "/guide/mcp" },
        ],
      },
      {
        text: "Workflows",
        items: [
          { text: "For Miners", link: "/guide/miners" },
          { text: "For Maintainers", link: "/guide/maintainers" },
          { text: "GitHub App Setup", link: "/guide/github-app-setup" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API", link: "/reference/api" },
          { text: "Privacy", link: "/security/privacy" },
          { text: "Terms", link: "/security/terms" },
          { text: "Support", link: "/support" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/JSONbored/gittensory" }],
    search: {
      provider: "local",
    },
  },
});
