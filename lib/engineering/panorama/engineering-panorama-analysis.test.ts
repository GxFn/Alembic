import { describe, expect, it } from "vitest";
import type { EngineeringCodeGraphReader } from "../code/EngineeringCodeGraphModel.js";
import type { EngineeringRelationshipGraph } from "../foundation/EngineeringCoreTypes.js";
import { EngineeringDimensionAnalyzer } from "./EngineeringDimensionAnalyzer.js";
import { EngineeringPanoramaService } from "./EngineeringPanoramaService.js";
import type {
  EngineeringPanoramaModuleDetail,
  EngineeringPanoramaRefinement,
} from "./EngineeringPanoramaTypes.js";
import { EngineeringTechStackProfiler } from "./EngineeringTechStackProfiler.js";

describe("engineering panorama analysis facts", () => {
  it("aggregates tech stack facts from languages, external deps, package nodes, and role signals", () => {
    const profile = new EngineeringTechStackProfiler().profile({
      files: [
        file("src/App.tsx", "typescript", "App"),
        file("src/api.ts", "typescript", "Networking"),
        file("package.json", "json", "App"),
      ],
      dependencyGraph: {
        nodes: [{ id: "vitest", type: "external", version: "2.0.0" }],
        edges: [],
      },
      externalDeps: [
        { name: "react", fanIn: 3, dependedBy: ["App", "Feature", "Shell"], weight: 1.5 },
        { name: "prisma", fanIn: 1, dependedBy: ["Storage"], weight: 0.5 },
      ],
      modules: [
        moduleDetail("App", "ui", ["src/App.tsx"], { roleConfidence: 0.9 }),
        moduleDetail("Networking", "networking", ["src/api.ts"]),
      ],
      importFacts: [
        { filePath: "src/App.tsx", specifier: "react" },
        { filePath: "src/api.ts", specifier: "axios" },
      ],
    });

    expect(profile.primaryLanguages).toEqual(["TypeScript"]);
    expect(profile.categories.find((category) => category.name === "framework")?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "react", fanIn: 3 })]),
    );
    expect(profile.categories.find((category) => category.name === "storage")?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "prisma" })]),
    );
    expect(profile.categories.find((category) => category.name === "test")?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "vitest", version: "2.0.0" })]),
    );
    expect(profile.hotspots).toContainEqual(
      expect.objectContaining({ name: "react", category: "framework", fanIn: 3 }),
    );
  });

  it("computes dimension coverage and exposes recipe coverage as a placeholder without DB facts", () => {
    const result = new EngineeringDimensionAnalyzer().analyze({
      modules: [
        moduleDetail("App", "ui", ["App/Main.ts"], { testFileCount: 1 }),
        moduleDetail("Core", "core", ["Core/index.ts"], { docFileCount: 1 }),
        moduleDetail("Loose", "utility", ["Loose/generated.ts"], {
          sourceFileCount: 0,
          testFileCount: 0,
          docFileCount: 0,
        }),
      ],
      relationships: emptyRelationships(),
      refinement: refinement(),
      codeGraph: codeGraph(),
    });

    expect(result.dimensions.moduleCoverage).toEqual(
      expect.objectContaining({
        totalModules: 3,
        coveredModules: 2,
        weakModules: ["Loose"],
      }),
    );
    expect(result.dimensions.languageCoverage.primaryLanguages).toEqual(["typescript"]);
    expect(result.dimensions.recipeCoverage).toEqual(
      expect.objectContaining({
        source: "placeholder",
        totalRecipes: 0,
        reason: expect.stringContaining("No repository or recipe DB is connected"),
      }),
    );
  });

  it("prioritizes cycle and layer-conflict gaps and lowers health score", () => {
    const result = new EngineeringDimensionAnalyzer().analyze({
      modules: [
        moduleDetail("App", "ui", ["App/Main.ts"]),
        moduleDetail("Core", "core", ["Core/index.ts"]),
      ],
      relationships: emptyRelationships(),
      refinement: refinement({
        cycles: [{ cycle: ["App", "Core", "App"], severity: "warning" }],
        layerViolations: [
          { from: "Core", to: "App", fromLayer: 0, toLayer: 2, relation: "depends_on" },
        ],
      }),
      codeGraph: codeGraph(),
    });

    expect(result.gaps[0]).toEqual(
      expect.objectContaining({ type: "layer-conflict", priority: "high" }),
    );
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "architecture-cycle", priority: "medium" }),
      ]),
    );
    expect(result.health.score).toBeLessThan(result.dimensions.overallScore);
    expect(["risk", "critical"]).toContain(result.health.status);
  });

  it("summarizes call-flow and data-flow edges from relationships and code graph facts", () => {
    const result = new EngineeringDimensionAnalyzer().analyze({
      modules: [
        moduleDetail("App", "ui", ["App/Main.ts"]),
        moduleDetail("Core", "core", ["Core/index.ts"]),
      ],
      relationships: {
        moduleEdges: [
          { from: "App", to: "Core", relation: "calls", source: "call", weight: 1 },
          { from: "Core", to: "App", relation: "data_flow", source: "data_flow", weight: 0.8 },
        ],
        cycles: [],
        layers: [],
        layerViolations: [],
      },
      refinement: refinement(),
      codeGraph: codeGraph(
        [
          callEdge("App.start", "Core.load", "App/Main.ts", "Core/index.ts"),
          callEdge("App.start", "Core.load", "App/Main.ts", "Core/index.ts"),
          callEdge("Core.load", "Core.parse", "Core/index.ts", "Core/index.ts"),
        ],
        [
          {
            from: "Core.load",
            to: "App.state",
            flowType: "return",
            direction: "forward",
            confidence: 0.8,
            filePath: "Core/index.ts",
            line: 7,
            source: "Core.load",
            sink: "App.state",
          },
        ],
      ),
    });

    expect(result.callFlow.edgeCounts).toEqual({
      calls: 3,
      dataFlows: 1,
      relationshipCalls: 1,
      relationshipDataFlows: 1,
    });
    expect(result.callFlow.topCalled[0]).toEqual(
      expect.objectContaining({ id: "Core.load", count: 2, modules: ["Core"] }),
    );
    expect(result.callFlow.entryPoints).toEqual([
      expect.objectContaining({ id: "App.start", count: 2, modules: ["App"] }),
    ]);
    expect(result.callFlow.moduleFlows).toEqual(
      expect.arrayContaining([
        { from: "App", to: "Core", relation: "calls", count: 1, weight: 1 },
        { from: "Core", to: "App", relation: "data_flow", count: 1, weight: 0.8 },
      ]),
    );
  });

  it("maps explicit recipe facts into dimensions instead of using the placeholder", () => {
    const result = new EngineeringDimensionAnalyzer().analyze({
      modules: [moduleDetail("App", "ui", ["App/Main.ts"], { testFileCount: 1 })],
      relationships: emptyRelationships(),
      refinement: refinement(),
      codeGraph: codeGraph(),
      recipeFacts: [
        { title: "Layer dependency policy", dimensionId: "architecture-boundaries" },
        { title: "Vitest module strategy", category: "testing" },
      ],
    });

    expect(result.dimensions.recipeCoverage).toEqual(
      expect.objectContaining({
        source: "input-facts",
        totalRecipes: 2,
        coveredDimensions: 2,
      }),
    );
    expect(
      result.dimensions.dimensions.find((dimension) => dimension.id === "architecture-boundaries"),
    ).toEqual(expect.objectContaining({ recipeCount: 1, topRecipes: ["Layer dependency policy"] }));
  });

  it("integrates tech stack, dimensions, health, gaps, and call-flow into service snapshots", () => {
    const snapshot = new EngineeringPanoramaService().buildSnapshot({
      projectRoot: "/repo",
      files: [
        file("App/Main.ts", "typescript", "App"),
        file("Core/index.ts", "typescript", "Core"),
        file("Core/index.test.ts", "typescript", "Core", true),
        file("package.json", "json", "App"),
      ],
      dependencyGraph: {
        nodes: [{ id: "App" }, { id: "Core" }, { id: "react", type: "external" }],
        edges: [{ from: "App", to: "Core", type: "calls", weight: 1 }],
      },
      importFacts: [
        { filePath: "App/Main.ts", specifier: "react" },
        { filePath: "App/Main.ts", specifier: "Core" },
      ],
      recipeFacts: [{ title: "Module ownership", dimensionId: "module-structure" }],
      codeGraph: codeGraph([callEdge("App.start", "Core.load", "App/Main.ts", "Core/index.ts")]),
      computedAt: 1000,
    });

    expect(snapshot.techStack.categories.map((category) => category.name)).toContain("framework");
    expect(snapshot.dimensions.recipeCoverage.source).toBe("input-facts");
    expect(snapshot.health.score).toBeGreaterThanOrEqual(0);
    expect(snapshot.gaps).toBe(snapshot.health.gaps);
    expect(snapshot.callFlow.topCalled).toEqual([
      expect.objectContaining({ id: "Core.load", modules: ["Core"] }),
    ]);
    expect(snapshot.overview.health).toEqual(snapshot.health);
    expect(snapshot.overview.coverage.source).toBe("pure-analysis");
  });
});

function file(relativePath: string, language: string, targetName?: string, isTest?: boolean) {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    language,
    targetName,
    isTest,
  };
}

function moduleDetail(
  name: string,
  role: string,
  files: readonly string[],
  overrides?: Partial<EngineeringPanoramaModuleDetail>,
): EngineeringPanoramaModuleDetail {
  const sourceFileCount = overrides?.sourceFileCount ?? files.length;
  const testFileCount = overrides?.testFileCount ?? 0;
  const docFileCount = overrides?.docFileCount ?? 0;
  return {
    name,
    kind: "local",
    role,
    inferredRole: role,
    roleConfidence: overrides?.roleConfidence ?? 0.8,
    roleResolution: overrides?.roleResolution ?? "clear",
    roleSignals: [],
    uncertainSignals: [],
    fallbackSignals: [],
    discoverySignals: [],
    layer: null,
    files,
    fileCount: files.length + testFileCount + docFileCount,
    sourceFileCount,
    testFileCount,
    docFileCount,
    symbolCount: 0,
    languages: ["typescript"],
    fileGroups: {
      source: files,
      test: [],
      doc: [],
      config: [],
      byDirectory: [],
    },
    neighbors: { dependencies: [], dependents: [], externalDependencies: [] },
    incoming: [],
    outgoing: [],
    externalDeps: [],
    fanIn: 0,
    fanOut: 0,
    weightedFanIn: 0,
    weightedFanOut: 0,
    summary: `${name} summary`,
    ...overrides,
  };
}

function refinement(
  overrides?: Partial<EngineeringPanoramaRefinement>,
): EngineeringPanoramaRefinement {
  return {
    edges: [],
    cycles: [],
    metrics: new Map(),
    externalDeps: [],
    roles: new Map(),
    layers: [],
    layerViolations: [],
    configBasedLayers: false,
    ...overrides,
  };
}

function emptyRelationships(): EngineeringRelationshipGraph {
  return { moduleEdges: [], cycles: [], layers: [], layerViolations: [] };
}

function codeGraph(
  calls: ReturnType<typeof callEdge>[] = [],
  dataFlows: ReturnType<typeof dataFlowEdge>[] = [],
): EngineeringCodeGraphReader {
  return {
    getFileSymbols: () => null,
    getCallGraphEdges: () => calls,
    getDataFlowEdges: () => dataFlows,
  } as EngineeringCodeGraphReader;
}

function callEdge(caller: string, callee: string, sourceFilePath: string, targetFilePath: string) {
  return {
    caller,
    callee,
    callType: "direct",
    resolveMethod: "test",
    line: 1,
    filePath: sourceFilePath,
    isAwait: false,
    argCount: 0,
    sourceFilePath,
    targetFilePath,
  };
}

function dataFlowEdge(from: string, to: string, filePath: string) {
  return {
    from,
    to,
    flowType: "return",
    direction: "forward",
    confidence: 0.8,
    filePath,
    line: 1,
    source: from,
    sink: to,
  };
}
