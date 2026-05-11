import { describe, expect, it } from "vitest";
import type { EngineeringCodeGraphReader } from "../code/EngineeringCodeGraphModel.js";
import type {
  EngineeringDependencyGraph,
  EngineeringFile,
} from "../foundation/EngineeringCoreTypes.js";
import { EngineeringPanoramaService } from "./EngineeringPanoramaService.js";

describe("isolated engineering panorama service", () => {
  it("builds a pure snapshot with overview, module detail, stale markers, and refiner output", () => {
    const service = new EngineeringPanoramaService();
    const snapshot = service.buildSnapshot({
      projectRoot: "/repo",
      files: [
        file("App/MainView.swift", "swift", "App"),
        file("Core/Core.swift", "swift", "Core"),
        file("Core/Core.test.swift", "swift", "Core", true),
        file("Core/README.md", "markdown", "Core"),
      ],
      dependencyGraph: graph(),
      importFacts: [
        { filePath: "App/MainView.swift", specifier: "Core" },
        { filePath: "App/MainView.swift", specifier: "react" },
      ],
      codeGraph: uiCodeGraph(),
      generatedAt: 100,
      computedAt: 200,
      staleAfterMs: 50,
    });

    expect(snapshot.projectRoot).toBe("/repo");
    expect(snapshot.stale).toBe(true);
    expect(snapshot.cache).toEqual(
      expect.objectContaining({
        enabled: false,
        stale: true,
        generatedAt: 100,
        computedAt: 200,
        staleAfterMs: 50,
      }),
    );
    expect(snapshot.overview).toEqual(
      expect.objectContaining({
        moduleCount: 2,
        localModuleCount: 2,
        localDependencyCount: 1,
        externalDependencyCount: 2,
        cycleCount: 0,
        layerCount: 2,
        totalFileCount: 4,
        sourceFileCount: 2,
        testFileCount: 1,
        docFileCount: 1,
      }),
    );
    expect(snapshot.overview.health).toEqual(
      expect.objectContaining({ status: expect.any(String), score: expect.any(Number) }),
    );
    expect(snapshot.relationships.moduleEdges).toContainEqual(
      expect.objectContaining({ from: "App", to: "Core", source: "import" }),
    );
    expect(snapshot.relationships.moduleEdges).toContainEqual(
      expect.objectContaining({ from: "App", to: "react", source: "import" }),
    );
    expect(snapshot.externalDeps).toHaveLength(2);
    expect(snapshot.externalDeps).toContainEqual({
      name: "UIKit",
      fanIn: 1,
      dependedBy: ["App"],
      weight: 0.5,
    });
    expect(snapshot.externalDeps).toContainEqual({
      name: "react",
      fanIn: 1,
      dependedBy: ["App"],
      weight: 0.5,
    });
    expect(snapshot.roles.find((role) => role.module === "App")).toEqual(
      expect.objectContaining({
        role: "ui",
        resolution: "clear",
      }),
    );
  });

  it("projects module detail with file groups, neighbors, external deps, and fallback signals", () => {
    const service = new EngineeringPanoramaService();
    const snapshot = service.buildSnapshot({
      projectRoot: "/repo",
      files: [
        file("App/Main.ts", "typescript", "App"),
        file("Core/index.ts", "typescript", "Core"),
        file("Core/index.test.ts", "typescript", "Core", true),
        file("Core/README.md", "markdown", "Core"),
      ],
      dependencyGraph: graph(),
      importFacts: [
        { filePath: "App/Main.ts", specifier: "Core" },
        { filePath: "App/Main.ts", specifier: "lodash" },
      ],
      computedAt: 500,
    });

    const app = snapshot.modules.find((module) => module.name === "App");
    const core = snapshot.modules.find((module) => module.name === "Core");

    expect(app).toEqual(
      expect.objectContaining({
        name: "App",
        neighbors: {
          dependencies: ["Core"],
          dependents: [],
          externalDependencies: ["lodash"],
        },
      }),
    );
    expect(app?.outgoing.map((edge) => [edge.name, edge.sources])).toEqual([
      ["Core", ["import"]],
      ["lodash", ["import"]],
    ]);
    expect(app?.externalDeps).toEqual([
      { name: "lodash", fanIn: 1, dependedBy: ["App"], weight: 0.5 },
    ]);
    expect(core?.fileGroups).toEqual(
      expect.objectContaining({
        source: ["Core/index.ts"],
        test: ["Core/index.test.ts"],
        doc: ["Core/README.md"],
      }),
    );
    expect(core?.incoming.map((edge) => edge.name)).toEqual(["App"]);
    expect(app?.summary).toContain("External dependencies: lodash.");
  });

  it("offers overview and module helpers without retaining cache state", () => {
    const service = new EngineeringPanoramaService();
    const input = {
      projectRoot: "/repo",
      files: [file("main.swift", "swift")],
      dependencyGraph: { nodes: [], edges: [] },
      computedAt: 1000,
    };

    const overview = service.getOverview(input);
    const rootModule = service.getModule(input, "(root)");

    expect(overview).toEqual(
      expect.objectContaining({
        moduleCount: 1,
        fallbackModuleCount: 1,
        localDependencyCount: 0,
      }),
    );
    expect(rootModule).toEqual(
      expect.objectContaining({
        name: "(root)",
        kind: "fallback",
        fallbackSignals: ["unknown-fallback"],
      }),
    );
    expect(service.getModule(input, "missing")).toBeNull();
  });
});

function graph(): EngineeringDependencyGraph {
  return {
    nodes: [{ id: "App" }, { id: "Core" }],
    edges: [],
  };
}

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

function uiCodeGraph(): EngineeringCodeGraphReader {
  return {
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
  } as EngineeringCodeGraphReader;
}
