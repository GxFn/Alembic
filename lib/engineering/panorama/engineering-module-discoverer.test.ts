import { describe, expect, it } from "vitest";
import type { EngineeringCodeGraphReader } from "../code/EngineeringCodeGraphModel.js";
import type { EngineeringFile } from "../foundation/EngineeringCoreTypes.js";
import { EngineeringModuleDiscoverer } from "./EngineeringModuleDiscoverer.js";
import { EngineeringPanoramaRefiner } from "./EngineeringPanoramaRefiner.js";

describe("isolated engineering module discoverer", () => {
  it("emits config layers and summaries that feed the panorama refiner", () => {
    const result = new EngineeringModuleDiscoverer().discover({
      projectRoot: "/repo",
      files: [
        file("App/MainView.swift", "swift", "App"),
        file("Core/Core.swift", "swift", "Core"),
        file("Networking/APIClient.swift", "swift", "Networking"),
      ],
      dependencyGraph: {
        nodes: [
          { id: "App", layer: "UI" },
          { id: "Core", layer: "Foundation" },
          { id: "Networking", layer: "Service" },
        ],
        edges: [
          { from: "App", to: "Networking", type: "targetDependency" },
          { from: "Networking", to: "Core", type: "dependency" },
        ],
        layers: [
          { name: "UI", order: 0, accessibleLayers: ["Service", "Foundation"] },
          { name: "Service", order: 1, accessibleLayers: ["Foundation"] },
          { name: "Foundation", order: 2, accessibleLayers: [] },
        ],
      },
    });

    const refinement = new EngineeringPanoramaRefiner().refine({
      projectRoot: "/repo",
      files: [
        file("App/MainView.swift", "swift", "App"),
        file("Core/Core.swift", "swift", "Core"),
        file("Networking/APIClient.swift", "swift", "Networking"),
      ],
      dependencyGraph: result.dependencyGraph,
      panorama: result.panorama,
      relationships: result.relationships,
      codeGraph: emptyCodeGraph(),
    });

    expect(result.configLayers.map((layer) => layer.name)).toEqual(["UI", "Service", "Foundation"]);
    expect(result.panorama.modules.map((module) => [module.name, module.role])).toEqual([
      ["App", "ui"],
      ["Core", "core"],
      ["Networking", "service"],
    ]);
    expect(refinement.configBasedLayers).toBe(true);
    expect(refinement.layers.map((layer) => [layer.name, layer.modules])).toEqual([
      ["Foundation", ["Core"]],
      ["Service", ["Networking"]],
      ["UI", ["App"]],
    ]);
  });

  it("skips vendor and resource paths while keeping source files", () => {
    const result = new EngineeringModuleDiscoverer().discover({
      projectRoot: "/repo",
      files: [
        file("App/Main.swift", "swift"),
        file("Pods/Alamofire/Session.swift", "swift"),
        file("App/Assets.xcassets/Contents.json", "json"),
        file("App/Resources/Localizable.swift", "swift"),
      ],
      dependencyGraph: { nodes: [], edges: [] },
    });

    expect(result.modules.map((module) => module.name)).toEqual(["App"]);
    expect(result.modules[0]?.files).toEqual(["App/Main.swift"]);
  });

  it("decomposes host modules and injects an application config layer", () => {
    const result = new EngineeringModuleDiscoverer().discover({
      projectRoot: "/repo",
      files: [
        file("HostApp/AppDelegate.swift", "swift", "HostApp"),
        file("HostApp/Checkout/CartView.swift", "swift", "HostApp"),
        file("HostApp/Checkout/CartStore.swift", "swift", "HostApp"),
        file("HostApp/Profile/ProfileView.swift", "swift", "HostApp"),
        file("HostApp/Profile/ProfileStore.swift", "swift", "HostApp"),
        file("HostApp/Assets.xcassets/Contents.json", "json", "HostApp"),
      ],
      dependencyGraph: {
        nodes: [{ id: "HostApp", type: "host" }],
        edges: [],
        layers: [{ name: "Foundation", order: 1, accessibleLayers: [] }],
      },
    });

    expect(result.configLayers.map((layer) => [layer.name, layer.order])).toEqual([
      ["Application", 0],
      ["Foundation", 1],
    ]);
    expect(module(result, "Checkout")?.files).toEqual([
      "HostApp/Checkout/CartStore.swift",
      "HostApp/Checkout/CartView.swift",
    ]);
    expect(module(result, "Profile")?.configLayer).toBe("Application");
    expect(module(result, "HostApp")?.role).toBe("app");
  });

  it("infers missing dependency edges from import fallback facts", () => {
    const result = new EngineeringModuleDiscoverer().discover({
      projectRoot: "/repo",
      files: [
        file("App/Main.ts", "typescript", "App"),
        file("Core/index.ts", "typescript", "Core"),
      ],
      dependencyGraph: {
        nodes: [{ id: "App" }, { id: "Core" }],
        edges: [],
      },
      importFacts: [
        { filePath: "App/Main.ts", specifier: "Core" },
        { filePath: "App/Main.ts", specifier: "react" },
      ],
    });

    expect(result.relationships.moduleEdges).toEqual([
      { from: "App", to: "Core", relation: "depends_on", source: "import", weight: 0.5 },
      { from: "App", to: "react", relation: "depends_on", source: "import", weight: 0.5 },
    ]);
    expect(module(result, "App")?.neighbors).toEqual({
      dependencies: ["Core"],
      dependents: [],
      externalDependencies: ["react"],
    });
    expect(result.signals).toContainEqual(
      expect.objectContaining({ source: "import-fallback", module: "App" }),
    );
  });

  it("falls back to an unknown root module when no module facts exist", () => {
    const result = new EngineeringModuleDiscoverer().discover({
      projectRoot: "/repo",
      files: [file("main.swift", "swift")],
      dependencyGraph: { nodes: [], edges: [] },
    });

    expect(result.modules).toEqual([
      expect.objectContaining({
        name: "(root)",
        kind: "fallback",
        role: "core",
        discoverySignals: ["unknown-fallback"],
        files: ["main.swift"],
      }),
    ]);
  });

  it("reports module file groups and neighbors as basic facts", () => {
    const result = new EngineeringModuleDiscoverer().discover({
      projectRoot: "/repo",
      files: [
        file("Feature/View.tsx", "typescript", "Feature"),
        file("Feature/View.test.tsx", "typescript", "Feature", true),
        file("Feature/README.md", "markdown", "Feature"),
        file("Feature/config.json", "json", "Feature"),
        file("Core/index.ts", "typescript", "Core"),
      ],
      dependencyGraph: {
        nodes: [{ id: "Feature" }, { id: "Core" }],
        edges: [{ from: "Feature", to: "Core", type: "dependency" }],
      },
    });

    expect(module(result, "Feature")?.fileGroups).toEqual({
      source: ["Feature/View.tsx"],
      test: ["Feature/View.test.tsx"],
      doc: ["Feature/README.md"],
      config: ["Feature/config.json"],
    });
    expect(module(result, "Core")?.neighbors).toEqual({
      dependencies: [],
      dependents: ["Feature"],
      externalDependencies: [],
    });
  });
});

function file(
  relativePath: string,
  language: string,
  targetName?: string,
  isTest?: boolean,
): EngineeringFile {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    language,
    targetName,
    isTest,
  };
}

function module(result: ReturnType<EngineeringModuleDiscoverer["discover"]>, name: string) {
  return result.modules.find((candidate) => candidate.name === name);
}

function emptyCodeGraph(): EngineeringCodeGraphReader {
  return {
    getFileSymbols: () => null,
    getClassInfo: () => null,
  } as EngineeringCodeGraphReader;
}
