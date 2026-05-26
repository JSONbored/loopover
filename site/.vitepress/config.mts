import { defineConfig } from "vitepress";

const siteUrl = process.env.GITTENSORY_SITE_URL ?? "https://gittensory.aethereal.dev/";
const siteBase = process.env.GITTENSORY_SITE_BASE ?? "/";

export default defineConfig({
  title: "Gittensory",
  description: "Backend intelligence, MCP preflight, and GitHub App review context for Gittensor contributors and maintainers.",
  base: siteBase,
  cleanUrls: true,
  lastUpdated: true,
  appearance: false,
  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    ["link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" }],
    ["meta", { property: "og:title", content: "Gittensory" }],
    ["meta", { property: "og:description", content: "Private decision intelligence for healthier Gittensor repo participation." }],
    ["meta", { property: "og:url", content: siteUrl }],
    ["meta", { name: "theme-color", content: "#050608" }],
  ],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Install", link: "/guide/install" },
      { text: "MCP", link: "/guide/mcp" },
      { text: "GitHub App", link: "/guide/github-app-setup" },
      { text: "API", link: "/reference/api" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Install", link: "/guide/install" },
          { text: "MCP", link: "/guide/mcp" },
          { text: "Auth", link: "/guide/auth" },
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
