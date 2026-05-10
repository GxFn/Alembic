import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["{bin,lib,scripts}/**/*.{test,spec}.ts"],
    exclude: ["dist/**", "node_modules/**", "plugins/**", "docs-dev/**"],
    passWithNoTests: true,
  },
});
