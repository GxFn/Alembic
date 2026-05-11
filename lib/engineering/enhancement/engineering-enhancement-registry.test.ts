import { describe, expect, it } from "vitest";
import { getEngineeringEnhancementRegistry, initEngineeringEnhancementRegistry } from "./index.js";

describe("engineering enhancement registry", () => {
  it("wraps the current 14 enhancement packs as class instances", () => {
    const registry = initEngineeringEnhancementRegistry();
    const packs = registry.all();

    expect(packs).toHaveLength(14);
    expect(packs.every((pack) => typeof pack.getExtraDimensions === "function")).toBe(true);
    expect(packs.map((pack) => pack.id)).toEqual(
      expect.arrayContaining([
        "react",
        "nextjs",
        "vue",
        "node-server",
        "django",
        "fastapi",
        "spring",
        "android",
        "rust-web",
        "rust-tokio",
        "go-web",
        "go-grpc",
        "python-ml",
        "python-langchain",
      ]),
    );
  });

  it("resolves packs and preserves dimension, guard, and pattern APIs", () => {
    const registry = getEngineeringEnhancementRegistry();
    const resolved = registry.resolve("typescript", ["react", "nextjs"]);

    expect(resolved.map((pack) => pack.id)).toEqual(expect.arrayContaining(["react", "nextjs"]));
    expect(
      registry.getExtraDimensions("typescript", ["react"]).map((dimension) => dimension.id),
    ).toContain("hook-pattern-scan");
    expect(registry.getGuardRules("typescript", ["react"]).map((rule) => rule.ruleId)).toContain(
      "react-no-direct-dom",
    );
    expect(
      registry.detectPatterns(
        { methods: [{ name: "useProjectState", line: 12 }], imports: ["react"] },
        "typescript",
        ["react"],
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ type: "custom-hook" })]));
  });

  it("keeps Vue preprocessing available through the pack interface", () => {
    const registry = initEngineeringEnhancementRegistry();
    const result = registry.preprocessFile(
      '<template><div /></template><script setup lang="ts">const answer = 42;</script>',
      ".vue",
      "typescript",
      ["vue"],
    );

    expect(result).toEqual({
      content: "const answer = 42;",
      lang: "typescript",
      packId: "vue",
    });
  });
});
