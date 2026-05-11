import { describe, expect, it } from "vitest";
import { DimensionCopy } from "./DimensionCopy.js";
import {
  buildTierPlan,
  classifyRecipeToDimension,
  DIMENSION_REGISTRY,
  getDimension,
  getDimensionsByLayer,
  resolveActiveDimensions,
} from "./DimensionRegistry.js";
import { getDimensionSOP, sopToCompactText } from "./DimensionSop.js";
import {
  dimensionTags,
  recipeDimensionIdOrUnknown,
  recipeStorageBucket,
  resolveRecipeDimensionId,
} from "./RecipeDimension.js";
import { ALL_DIMENSION_IDS } from "./UnifiedDimension.js";

describe("engineering dimension registry", () => {
  it("exposes the migrated 25 dimension registry with stable layer counts", () => {
    expect(ALL_DIMENSION_IDS).toHaveLength(25);
    expect(DIMENSION_REGISTRY).toHaveLength(25);
    expect(getDimensionsByLayer("universal")).toHaveLength(13);
    expect(getDimensionsByLayer("language")).toHaveLength(7);
    expect(getDimensionsByLayer("framework")).toHaveLength(5);
    expect(getDimension("architecture")).toMatchObject({
      layer: "universal",
      displayGroup: "architecture",
    });
  });

  it("resolves active language and framework dimensions", () => {
    const active = resolveActiveDimensions("typescript", ["react"]);
    const ids = active.map((dimension) => dimension.id);

    expect(ids).toContain("architecture");
    expect(ids).toContain("ts-js-module");
    expect(ids).toContain("react-patterns");
    expect(ids).not.toContain("vue-patterns");
    expect(active).toHaveLength(15);
  });

  it("builds tier plans from active dimensions", () => {
    const plan = buildTierPlan(resolveActiveDimensions("typescript", ["react"]));

    expect(plan[0]).toEqual(
      expect.arrayContaining(["architecture", "ts-js-module", "react-patterns"]),
    );
    expect(plan.flat()).toContain("agent-guidelines");
    expect(plan.every((tier) => tier.length > 0)).toBe(true);
  });

  it("classifies recipe fields and emits dimension tags", () => {
    expect(classifyRecipeToDimension("networking", "")).toBe("networking-api");
    expect(classifyRecipeToDimension("", "Network")).toBe("networking-api");
    expect(resolveRecipeDimensionId({ category: "architecture" })).toBe("architecture");
    expect(
      resolveRecipeDimensionId({
        tags: "bootstrap,dimension:react-patterns",
      }),
    ).toBe("react-patterns");
    expect(recipeDimensionIdOrUnknown({ topicHint: "swiftui-view" })).toBe("swiftui-patterns");
    expect(recipeStorageBucket({ category: "custom-category" })).toBe("custom-category");
    expect(dimensionTags("architecture", ["existing"])).toEqual(
      expect.arrayContaining(["existing", "architecture", "dimension:architecture", "bootstrap"]),
    );
  });

  it("keeps copy and SOP compact helpers available", () => {
    expect(DimensionCopy.get("design-patterns", "python")).toMatchObject({
      label: "设计模式与代码惯例",
    });

    const sop = getDimensionSOP("architecture");
    expect(sop?.steps.length).toBeGreaterThanOrEqual(4);
    expect(sopToCompactText(sop ?? {})).toContain("架构层次映射");
  });
});
