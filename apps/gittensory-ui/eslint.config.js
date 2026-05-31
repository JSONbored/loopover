import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: [
            "badgeVariants",
            "buttonVariants",
            "docsNav",
            "navigationMenuTriggerStyle",
            "sidebarMenuButtonVariants",
            "toggleVariants",
            "useFormField",
            "usePreviewDataState",
            "useSidebar",
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  eslintPluginPrettier,
  {
    files: ["src/components/site/**/*.{ts,tsx}", "src/routes/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(^|\\s)(text-(2xs|xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)|text-\\[\\d|leading-(none|tight|snug|normal|relaxed|loose|3|4|5|6|7|8|9|10)|leading-\\[|rounded-(sm|md|lg|xl|2xl|3xl)|divide-y(\\s|$)|border-(t|b|l|r)(\\s|$))(\\s|$)/]",
          message:
            "Use design tokens instead: text-token-*, leading-token-*, rounded-token, border-hairline / divide-hairline. See src/styles.css.",
        },
        {
          selector:
            "TemplateElement[value.raw=/(^|\\s)(text-(2xs|xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)|leading-(none|tight|snug|normal|relaxed|loose)|rounded-(sm|md|lg|xl|2xl|3xl))(\\s|$)/]",
          message:
            "Use design tokens (text-token-*, leading-token-*, rounded-token, border-hairline) in template strings too.",
        },
      ],
    },
  },
);
