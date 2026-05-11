import { describe, expect, it } from "vitest";
import {
  computeEngineeringFanMetrics,
  EngineeringLanguageProfiles,
  EngineeringLanguageService,
  engineeringModuleNameForPath,
  findEngineeringCycles,
  mergeEngineeringWeightedEdges,
} from "./index.js";

describe("lib engineering foundation", () => {
  it("normalizes language facts through the new bottom layer", () => {
    expect(EngineeringLanguageService.inferLang("Sources/App/AppDelegate.swift")).toBe("swift");
    expect(EngineeringLanguageService.normalize("objc")).toBe("objectivec");
    expect(EngineeringLanguageProfiles.familyOf("tsx")).toBe("web");
    expect(EngineeringLanguageProfiles.roleForConfigLayer("Foundation")).toBe("core");
    expect(EngineeringLanguageProfiles.superclassRoles(["apple"]).UIViewController).toBe("ui");
    expect(
      EngineeringLanguageProfiles.importRolePatterns(["web"]).map((pattern) => pattern.role),
    ).toContain("networking");
  });

  it("keeps graph primitives independent from upper engineering layers", () => {
    const edges = mergeEngineeringWeightedEdges([
      { from: "App", to: "Core", relation: "depends_on", weight: 0.5 },
      { from: "App", to: "Core", relation: "depends_on", weight: 0.5 },
      { from: "Core", to: "Data", relation: "calls", weight: 1 },
      { from: "Data", to: "App", relation: "data_flow", weight: 0.8 },
    ]);

    expect(edges).toContainEqual({ from: "App", to: "Core", relation: "depends_on", weight: 1 });
    expect(findEngineeringCycles(edges).map((cycle) => [...cycle.cycle].sort())).toEqual([
      ["App", "Core", "Data"],
    ]);
    expect(computeEngineeringFanMetrics(edges, ["App", "Core"]).get("Core")).toEqual({
      fanIn: 1,
      fanOut: 1,
      weightedFanIn: 1,
      weightedFanOut: 1,
    });
  });

  it("keeps workspace path rules in the new engineering module", () => {
    expect(engineeringModuleNameForPath("packages/app/src/index.ts")).toBe("packages/app");
    expect(engineeringModuleNameForPath("Sources/Core/Core.swift")).toBe("Sources");
  });
});
