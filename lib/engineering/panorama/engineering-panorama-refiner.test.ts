import { describe, expect, it } from "vitest";
import type { EngineeringCodeGraphReader } from "../code/EngineeringCodeGraphModel.js";
import {
  EngineeringPanoramaRefiner,
  type EngineeringPanoramaRefinerInput,
} from "./EngineeringPanoramaRefiner.js";

describe("isolated engineering panorama refiner", () => {
  it("refines coupling, layers, external deps, and roles without upper-layer dependencies", () => {
    const codeGraph: EngineeringCodeGraphReader = {
      getFileSymbols: (relativePath) =>
        relativePath === "App/MainView.swift"
          ? {
              path: relativePath,
              languageId: "swift",
              classes: ["MainView"],
              protocols: [],
              categories: [],
              imports: [{ module: "UIKit" }],
            }
          : null,
      getClassInfo: (className) =>
        className === "MainView"
          ? {
              name: "MainView",
              filePath: "App/MainView.swift",
              superClass: "UIViewController",
              protocols: [],
            }
          : null,
    };

    const input: EngineeringPanoramaRefinerInput = {
      projectRoot: "/tmp/Demo",
      files: [
        {
          name: "MainView.swift",
          path: "/tmp/Demo/App/MainView.swift",
          relativePath: "App/MainView.swift",
          language: "swift",
          targetName: "App",
        },
        {
          name: "Core.swift",
          path: "/tmp/Demo/Core/Core.swift",
          relativePath: "Core/Core.swift",
          language: "swift",
          targetName: "Core",
        },
        {
          name: "APIClient.swift",
          path: "/tmp/Demo/Networking/APIClient.swift",
          relativePath: "Networking/APIClient.swift",
          language: "swift",
          targetName: "Networking",
        },
      ],
      dependencyGraph: {
        nodes: [
          { id: "App", layer: "UI" },
          { id: "Core", layer: "Foundation" },
          { id: "Networking", layer: "Service" },
          { id: "Alamofire", type: "external" },
        ],
        edges: [],
        layers: [
          { name: "UI", order: 0, accessibleLayers: ["Service", "Foundation"] },
          { name: "Service", order: 1, accessibleLayers: ["Foundation"] },
          { name: "Foundation", order: 2, accessibleLayers: [] },
        ],
      },
      panorama: {
        modules: [
          moduleSummary("App", "core", ["App/MainView.swift"], ["swift"]),
          moduleSummary("Core", "core", ["Core/Core.swift"], ["swift"]),
          moduleSummary("Networking", "service", ["Networking/APIClient.swift"], ["swift"]),
        ],
      },
      relationships: {
        moduleEdges: [
          { from: "App", to: "Core", relation: "depends_on", source: "config", weight: 1 },
          { from: "App", to: "Networking", relation: "calls", source: "call", weight: 1 },
          {
            from: "Networking",
            to: "Core",
            relation: "data_flow",
            source: "data_flow",
            weight: 1,
          },
          { from: "App", to: "Alamofire", relation: "depends_on", source: "config", weight: 1 },
        ],
        cycles: [],
        layers: [],
        layerViolations: [],
      },
      codeGraph,
    };

    const refinement = new EngineeringPanoramaRefiner().refine(input);

    expect(refinement.edges).toContainEqual(
      expect.objectContaining({ from: "App", to: "Core", relation: "depends_on", weight: 0.5 }),
    );
    expect(refinement.edges).toContainEqual(
      expect.objectContaining({
        from: "Networking",
        to: "Core",
        relation: "data_flow",
        weight: 0.8,
      }),
    );
    expect(refinement.externalDeps).toEqual([
      { name: "Alamofire", fanIn: 1, dependedBy: ["App"], weight: 0.5 },
    ]);
    expect(refinement.layers.map((layer) => [layer.name, layer.source, layer.modules])).toEqual([
      ["Foundation", "config", ["Core"]],
      ["Service", "config", ["Networking"]],
      ["UI", "config", ["App"]],
    ]);
    expect(refinement.roles.get("App")).toEqual(
      expect.objectContaining({
        refinedRole: "ui",
        signals: expect.arrayContaining([
          expect.objectContaining({ source: "ast-structure" }),
          expect.objectContaining({ source: "config-layer" }),
        ]),
      }),
    );
  });
});

function moduleSummary(
  name: string,
  role: string,
  representativePaths: readonly string[],
  languages: readonly string[],
): EngineeringPanoramaRefinerInput["panorama"]["modules"][number] {
  return {
    name,
    role,
    fileCount: representativePaths.length,
    sourceFileCount: representativePaths.length,
    testFileCount: 0,
    docFileCount: 0,
    symbolCount: 0,
    dependencyCount: 0,
    dependentCount: 0,
    externalDependencyCount: 0,
    languages,
    representativePaths,
  };
}
