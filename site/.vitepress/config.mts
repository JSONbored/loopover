import { defineConfig } from "vitepress";

const siteUrl = process.env.GITTENSORY_SITE_URL ?? "https://jsonbored.github.io/gittensory/";
const siteBase = process.env.GITTENSORY_SITE_BASE ?? "/gittensory/";

export default defineConfig({
  title: "Gittensory",
  description: "Backend intelligence, MCP preflight, and GitHub App review context for Gittensor contributors and maintainers.",
  base: siteBase,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { property: "og:title", content: "Gittensory" }],
    ["meta", { property: "og:description", content: "Private decision intelligence for healthier Gittensor repo participation." }],
    ["meta", { property: "og:url", content: siteUrl }],
    ["meta", { name: "theme-color", content: "#111827" }],
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
