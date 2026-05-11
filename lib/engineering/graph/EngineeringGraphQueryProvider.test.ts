import { describe, expect, it } from "vitest";
import type { EngineeringWorkflowArtifact } from "../workflow/EngineeringWorkflowTypes.js";
import { EngineeringWorkflowGraphQueryProvider } from "./EngineeringGraphQueryProvider.js";

describe("EngineeringWorkflowGraphQueryProvider", () => {
  it("hydrates call/data-flow artifact edges for path, impact, and callImpact queries", () => {
    const provider = new EngineeringWorkflowGraphQueryProvider({ artifact: fixtureArtifact() });

    const path = provider.query({
      operation: "path",
      from: "UI.render",
      to: "property:Repository.cache",
      maxDepth: 3,
    }).result as {
      readonly found: boolean;
      readonly path: { readonly nodes: readonly string[]; readonly distance: number } | null;
    };
    expect(path).toMatchObject({
      found: true,
      path: {
        distance: 3,
        nodes: [
          "method:UI.render",
          "method:ViewModel.refresh",
          "method:Repository.load",
          "property:Repository.cache",
        ],
      },
    });

    const impact = provider.query({
      operation: "impact",
      ref: "Repository.load",
      maxDepth: 2,
      direction: "both",
      includeStart: true,
    }).result as { readonly distanceById: Readonly<Record<string, number>> };
    expect(impact.distanceById).toMatchObject({
      "method:UI.render": 2,
      "method:ViewModel.refresh": 1,
      "method:Repository.load": 0,
      "property:Repository.cache": 1,
    });

    const callImpact = provider.query({
      operation: "callImpact",
      ref: "Repository.load",
      maxDepth: 2,
    }).result as {
      readonly relationCounts: Readonly<Record<string, number>>;
      readonly directCallers: number;
      readonly transitiveCallers: number;
      readonly affectedFiles: readonly string[];
    };
    expect(callImpact).toMatchObject({
      relationCounts: { calls: 2, data_flow: 1 },
      directCallers: 1,
      transitiveCallers: 2,
      affectedFiles: ["App/UI.swift", "App/ViewModel.swift", "Core/Repository.swift"],
    });
  });

  it("supports topology, entities, edges, and conformances over the hydrated entity graph", () => {
    const provider = new EngineeringWorkflowGraphQueryProvider({ artifact: fixtureArtifact() });

    const topology = provider.query({ operation: "topology" }).result as {
      readonly nodeCount: number;
      readonly edgeCount: number;
    };
    expect(topology.nodeCount).toBeGreaterThanOrEqual(5);
    expect(topology.edgeCount).toBeGreaterThanOrEqual(4);

    const entities = provider.query({ operation: "entities", entityType: "method" })
      .result as readonly { readonly id: string }[];
    expect(entities.map((entity) => entity.id)).toEqual([
      "method:Repository.load",
      "method:UI.render",
      "method:ViewModel.refresh",
    ]);

    const edges = provider.query({
      operation: "edges",
      ref: "Repository.load",
      relation: "calls",
      direction: "incoming",
    }).result as readonly { readonly from: string; readonly to: string }[];
    expect(edges).toEqual([
      expect.objectContaining({
        from: "method:ViewModel.refresh",
        to: "method:Repository.load",
      }),
    ]);

    const conformances = provider.query({
      operation: "conformances",
      ref: "Store",
    }).result as readonly { readonly class: string; readonly protocol: string }[];
    expect(conformances).toEqual([
      expect.objectContaining({ class: "Store", protocol: "Serializable" }),
    ]);
  });
});

function fixtureArtifact(): EngineeringWorkflowArtifact {
  const callGraph = [
    {
      caller: "App/UI.swift::UI.render",
      callee: "ViewModel.refresh",
      callType: "method",
      resolveMethod: "direct",
      line: 7,
      filePath: "App/UI.swift",
      isAwait: false,
      argCount: 0,
      sourceFilePath: "App/UI.swift",
      targetFilePath: "App/ViewModel.swift",
    },
    {
      caller: "ViewModel.refresh",
      callee: "Repository.load",
      callType: "method",
      resolveMethod: "summary",
      line: 12,
      filePath: "App/ViewModel.swift",
      isAwait: false,
      argCount: 0,
      sourceFilePath: "App/ViewModel.swift",
      targetFilePath: "Core/Repository.swift",
    },
  ];
  const dataFlow = [
    {
      from: "Repository.load",
      to: "property:Repository.cache",
      flowType: "store",
      direction: "forward",
      confidence: 0.8,
      filePath: "Core/Repository.swift",
      line: 20,
      source: "Repository.load",
      sink: "Repository.cache",
    },
  ];

  return {
    projectRoot: "/project",
    targets: [{ name: "App", path: "/project/App", type: "app", language: "swift" }],
    files: [],
    dependencyGraph: { nodes: [], edges: [] },
    codeGraph: {
      classes: [
        {
          name: "Store",
          filePath: "Core/Store.swift",
          line: 1,
          endLine: 20,
          superClass: null,
          protocols: ["Serializable"],
          properties: [],
          methods: [],
          imports: [],
        },
      ],
      protocols: [],
      categories: [],
      files: [],
      callGraphEdges: callGraph,
      dataFlowEdges: dataFlow,
      overview: {
        totalFiles: 0,
        totalClasses: 1,
        totalProtocols: 0,
        totalCategories: 0,
        totalMethods: 0,
        topLevelModules: [],
        entryPoints: [],
        classesPerModule: {},
      },
    },
    callGraph,
    dataFlow,
    entityGraph: {
      entities: [
        {
          id: "class:Store",
          type: "class",
          name: "Store",
          filePath: "Core/Store.swift",
          line: 1,
          metadata: {},
        },
        {
          id: "protocol:Serializable",
          type: "protocol",
          name: "Serializable",
          filePath: null,
          line: null,
          metadata: {},
        },
      ],
      edges: [
        {
          from: "class:Store",
          to: "protocol:Serializable",
          relation: "conforms",
          weight: 1,
          metadata: { source: "fixture" },
        },
      ],
      topology: {
        nodeCount: 2,
        edgeCount: 1,
        roots: ["class:Store"],
        leaves: ["protocol:Serializable"],
        isolated: [],
        components: [["class:Store", "protocol:Serializable"]],
        cycles: [],
      },
    },
    panoramaSnapshot: null,
    optionalStage: {
      status: "disabled",
      result: null,
      enhancementSignals: [],
      guardFindings: [],
      dimensionGates: [],
      dimensionFileRefs: [],
      diagnostics: [],
    },
    dimensionFileRefs: [],
    generatedArtifactBlacklist: [],
    truncated: false,
  };
}
