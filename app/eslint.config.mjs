import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // CLAUDE.md code style: function(){} syntax, no arrow functions.
    rules: {
      "no-restricted-syntax": ["error", { selector: "ArrowFunctionExpression", message: "Use function(){} syntax." }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/ort/**",
  ]),
]);

export default eslintConfig;
