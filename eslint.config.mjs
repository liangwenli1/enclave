import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Enclave 工作台的 ESLint 配置。 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      // Rust 的构建产物和本机缓存里有别人的 .js，不是这个项目的代码
      "target/**",
      ".cargo-docker/**",
      "apps/desktop/src-tauri/target/**",
      "apps/desktop/src-tauri/gen/**",
      "src/routeTree.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Disable rules that conflict with Prettier formatting.
  prettier,
);
