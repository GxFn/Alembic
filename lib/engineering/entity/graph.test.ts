import { describe, expect, it } from "vitest";
import { EmptyEngineeringCodeGraph, type EngineeringCodeGraphReader } from "../code/types.js";
import { EngineeringEntityGraph } from "./graph.js";

describe("EngineeringEntityGraph", () => {
  it("builds dependency, definition, and semantic entity edges from isolated inputs", () => {
    const graph = EngineeringEntityGraph.fromInput({
      targets: [
        { name: "App", path: "/repo/App", type: "app", language: "swift" },
        { name: "Core", path: "/repo/Core", type: "library", language: "swift" },
      ],
      files: [
        {
          name: "MainView.swift",
          path: "/repo/App/MainView.swift",
          relativePath: "App/MainView.swift",
          language: "swift",
          targetName: "App",
        },
        {
          name: "Model.swift",
          path: "/repo/Core/Model.swift",
          relativePath: "Core/Model.swift",
          language: "swift",
          targetName: "Core",
        },
        {
          name: "Model+Preview.swift",
          path: "/repo/Core/Model+Preview.swift",
          relativePath: "Core/Model+Preview.swift",
          language: "swift",
          targetName: "Core",
        },
      ],
      dependencyGraph: {
        nodes: [
          { id: "App", label: "Application", layer: "UI" },
          { id: "Core", layer: "Foundation" },
          { id: "UIKit", type: "external" },
        ],
        edges: [
          { from: "App", to: "Core", type: "depends_on", weight: 2 },
          { from: "App", to: "UIKit", type: "imports" },
        ],
      },
      codeGraph: fixtureCodeGraph(),
    });

    expect(graph.countByType()).toMatchObject({
      target: 2,
      file: 3,
      module: 2,
      external: 1,
      class: 3,
      protocol: 1,
      category: 1,
    });
    expect(graph.findEntity("module:UIKit")).toEqual(expect.objectContaining({ type: "external" }));
    expect(graph.findOutgoing("target:App", "contains")).toEqual([
      expect.objectContaining({
        from: "target:App",
        to: "file:App/MainView.swift",
        relation: "contains",
      }),
    ]);
    expect(graph.findOutgoing("module:App")).toEqual([
      expect.objectContaining({ to: "module:Core", relation: "depends_on", weight: 2 }),
      expect.objectContaining({ to: "module:UIKit", relation: "imports" }),
    ]);
    expect(graph.findOutgoing("file:App/MainView.swift", "defines")).toEqual([
      expect.objectContaining({ to: "class:MainView" }),
    ]);
    expect(graph.findOutgoing("class:MainView", "inherits")).toEqual([
      expect.objectContaining({ to: "class:BaseView" }),
    ]);
    expect(graph.findOutgoing("class:MainView", "conforms")).toEqual([
      expect.objectContaining({ to: "protocol:Renderable" }),
    ]);
    expect(graph.searchByName("view").map((entity) => entity.id)).toEqual(
      expect.arrayContaining(["class:BaseView", "category:MainView(Preview)", "class:MainView"]),
    );
  });

  it("supports builder API, BFS paths, impact radius, topology, and hot nodes", () => {
    const graph = new EngineeringEntityGraph()
      .addEntity(entity("pattern:Repository", "pattern", "Repository"))
      .addEntity(entity("module:App", "module", "App"))
      .addEntity(entity("module:Core", "module", "Core"))
      .addEntity(entity("module:Data", "module", "Data"))
      .addEntity(entity("module:Logging", "module", "Logging"))
      .addEntity(entity("symbol:App.start", "symbol", "start"))
      .addEdge(edge("pattern:Repository", "module:Data", "matches"))
      .addEdge(edge("module:App", "module:Core", "depends_on"))
      .addEdge(edge("module:Core", "module:Data", "depends_on"))
      .addEdge(edge("module:Data", "module:Core", "depends_on"))
      .addEdge(edge("module:App", "symbol:App.start", "defines"))
      .addEdge(edge("symbol:App.start", "module:Data", "references"));

    expect(graph.findPath("module:App", "module:Data")).toEqual(
      expect.objectContaining({
        nodes: ["module:App", "module:Core", "module:Data"],
        distance: 2,
      }),
    );
    expect(graph.findPath("pattern:Repository", "module:Core")?.nodes).toEqual([
      "pattern:Repository",
      "module:Data",
      "module:Core",
    ]);

    const impact = graph.getImpactRadius("module:App", 2);
    expect(impact.distanceById).toEqual({
      "module:App": 0,
      "module:Core": 1,
      "module:Data": 2,
      "symbol:App.start": 1,
    });
    expect(impact.edges.map((item) => `${item.from}->${item.to}:${item.relation}`)).toEqual([
      "module:App->module:Core:depends_on",
      "module:App->symbol:App.start:defines",
      "module:Core->module:Data:depends_on",
      "symbol:App.start->module:Data:references",
    ]);

    const topology = graph.getTopology();
    expect(topology.roots).toEqual(["module:App", "pattern:Repository"]);
    expect(topology.leaves).toEqual([]);
    expect(topology.isolated).toEqual(["module:Logging"]);
    expect(topology.components).toEqual([
      ["module:App", "module:Core", "module:Data", "pattern:Repository", "symbol:App.start"],
      ["module:Logging"],
    ]);
    expect(topology.cycles).toEqual([["module:Core", "module:Data"]]);

    expect(graph.getHotNodes(2)).toEqual([
      expect.objectContaining({ id: "module:Data", degree: 4, fanIn: 3, fanOut: 1 }),
      expect.objectContaining({ id: "module:Core", degree: 3, fanIn: 2, fanOut: 1 }),
    ]);
  });

  it("traverses callers and callees across method, class, and symbol call edges", () => {
    const graph = new EngineeringEntityGraph()
      .addEntity(entity("method:Controller.load", "method", "load"))
      .addEntity(entity("class:Service", "class", "Service"))
      .addEntity(entity("method:Service.fetch", "method", "fetch"))
      .addEntity(entity("method:Repository.query", "method", "query"))
      .addEntity(entity("symbol:Network.request", "symbol", "request"))
      .addEdge(
        edge("method:Controller.load", "method:Service.fetch", "calls", { callType: "direct" }),
      )
      .addEdge(edge("class:Service", "method:Service.fetch", "calls", { callType: "owner" }))
      .addEdge(
        edge("method:Service.fetch", "method:Repository.query", "calls", { callType: "direct" }),
      )
      .addEdge(
        edge("method:Service.fetch", "symbol:Network.request", "calls", { callType: "symbol" }),
      );

    expect(graph.getCallers("method:Repository.query", 2).map((item) => item.entity.id)).toEqual([
      "method:Service.fetch",
      "class:Service",
      "method:Controller.load",
    ]);
    expect(graph.getCallees("method:Service.fetch", 1).map((item) => item.entity.id)).toEqual([
      "method:Repository.query",
      "symbol:Network.request",
    ]);
    expect(graph.getCallers("method:Service.fetch", 1)).toEqual([
      expect.objectContaining({ callType: "owner", depth: 1 }),
      expect.objectContaining({ callType: "direct", depth: 1 }),
    ]);
  });

  it("keeps call impact separate from dependency impact and follows calls plus data flow", () => {
    const graph = new EngineeringEntityGraph()
      .addEntity(entity("method:UI.render", "method", "render", "App/UI.swift"))
      .addEntity(entity("method:ViewModel.refresh", "method", "refresh", "App/ViewModel.swift"))
      .addEntity(entity("method:Repository.load", "method", "load", "Core/Repository.swift"))
      .addEntity(entity("property:Repository.cache", "property", "cache", "Core/Repository.swift"))
      .addEntity(entity("module:Core", "module", "Core"))
      .addEntity(entity("module:SQLite", "external", "SQLite"))
      .addEdge(edge("method:UI.render", "method:ViewModel.refresh", "calls"))
      .addEdge(edge("method:ViewModel.refresh", "method:Repository.load", "calls"))
      .addEdge(edge("method:Repository.load", "property:Repository.cache", "data_flow"))
      .addEdge(edge("module:Core", "module:SQLite", "depends_on"));

    const callImpact = graph.getCallImpactRadius("method:Repository.load", 2);
    expect(callImpact.distanceById).toEqual({
      "method:Repository.load": 0,
      "method:UI.render": 2,
      "method:ViewModel.refresh": 1,
      "property:Repository.cache": 1,
    });
    expect(callImpact.relationCounts).toEqual({ calls: 2, data_flow: 1 });
    expect(callImpact.directCallers).toBe(1);
    expect(callImpact.transitiveCallers).toBe(2);
    expect(callImpact.affectedFiles).toEqual([
      "App/UI.swift",
      "App/ViewModel.swift",
      "Core/Repository.swift",
    ]);

    const dependencyImpact = graph.getImpactRadius("method:Repository.load", 2);
    expect(dependencyImpact.edges.map((item) => item.relation)).toEqual(["data_flow"]);
  });

  it("adds call graph and data-flow edges in memory without undercounting paths or impact", () => {
    const graph = new EngineeringEntityGraph().addCallGraph(
      [
        callEdge({
          caller: "App/UI.swift::UI.render",
          callee: "ViewModel.refresh",
          resolveMethod: "direct",
          filePath: "App/UI.swift",
          sourceFilePath: "App/UI.swift",
          targetFilePath: "App/ViewModel.swift",
        }),
        callEdge({
          caller: "App/UI.swift::UI.render",
          callee: "ViewModel.refresh",
          resolveMethod: "direct",
          filePath: "App/UI.swift",
          line: 9,
          sourceFilePath: "App/UI.swift",
          targetFilePath: "App/ViewModel.swift",
        }),
        callEdge({
          caller: "ViewModel.refresh",
          callee: "Repository.load",
          filePath: "App/ViewModel.swift",
          sourceFilePath: "App/ViewModel.swift",
          targetFilePath: "Core/Repository.swift",
        }),
      ],
      [
        dataFlowEdge({
          from: "Repository.load",
          to: "property:Repository.cache",
          flowType: "store",
          filePath: "Core/Repository.swift",
        }),
      ],
    );

    expect(graph.countByType()).toMatchObject({ method: 3, property: 1 });
    expect(graph.findOutgoing("method:UI.render", "calls")).toEqual([
      expect.objectContaining({
        to: "method:ViewModel.refresh",
        weight: 1,
        metadata: expect.objectContaining({ callCount: 2 }),
      }),
    ]);
    expect(graph.findPath("method:UI.render", "property:Repository.cache", undefined, 3)).toEqual(
      expect.objectContaining({
        nodes: [
          "method:UI.render",
          "method:ViewModel.refresh",
          "method:Repository.load",
          "property:Repository.cache",
        ],
        distance: 3,
      }),
    );

    const impact = graph.getImpactRadius("method:Repository.load", 2, "both");
    expect(impact.distanceById).toMatchObject({
      "method:UI.render": 2,
      "method:ViewModel.refresh": 1,
      "method:Repository.load": 0,
      "property:Repository.cache": 1,
    });

    const callImpact = graph.getCallImpactRadius("method:Repository.load", 2);
    expect(callImpact.relationCounts).toEqual({ calls: 2, data_flow: 1 });
    expect(callImpact.directCallers).toBe(1);
    expect(callImpact.transitiveCallers).toBe(2);
    expect(callImpact.affectedFiles).toEqual([
      "App/UI.swift",
      "App/ViewModel.swift",
      "Core/Repository.swift",
    ]);
  });

  it("generates structured agent context with a markdown renderer", () => {
    const graph = new EngineeringEntityGraph()
      .addEntity(entity("module:App", "module", "App"))
      .addEntity(entity("module:Core", "module", "Core"))
      .addEntity(entity("module:UIKit", "external", "UIKit"))
      .addEntity(entity("method:View.render", "method", "render", "App/View.swift"))
      .addEntity(entity("method:Presenter.load", "method", "load", "App/Presenter.swift"))
      .addEntity(entity("property:Presenter.state", "property", "state", "App/Presenter.swift"))
      .addEdge(edge("module:App", "module:Core", "depends_on"))
      .addEdge(edge("module:App", "module:UIKit", "imports"))
      .addEdge(edge("module:App", "method:View.render", "defines"))
      .addEdge(edge("method:View.render", "method:Presenter.load", "calls"))
      .addEdge(edge("method:Presenter.load", "property:Presenter.state", "data_flow"));

    const context = graph.generateContextForAgent({ maxHotNodes: 5 });
    expect(context.stats.edgesByRelation).toMatchObject({
      calls: 1,
      data_flow: 1,
      imports: 1,
    });
    expect(context.externalDependencies).toEqual([
      expect.objectContaining({ entity: expect.objectContaining({ id: "module:UIKit" }) }),
    ]);
    expect(context.callAndDataFlowSummary.hotCallees).toEqual([
      expect.objectContaining({
        entity: expect.objectContaining({ id: "method:Presenter.load" }),
        callerCount: 1,
      }),
    ]);
    expect(context.riskModules.map((item) => item.entity.id)).toContain("method:Presenter.load");

    const markdown = graph.renderAgentContextMarkdown(context);
    expect(markdown).toContain("## Engineering Entity Graph");
    expect(markdown).toContain("### External Dependencies");
    expect(markdown).toContain("### Calls And Data Flow");
    expect(markdown).toContain("### Risk Modules");
  });

  it("cleans entities and edges incrementally by file path or entity id", () => {
    const graph = new EngineeringEntityGraph()
      .addEntity(entity("file:App/View.swift", "file", "View.swift", "App/View.swift"))
      .addEntity(entity("method:View.render", "method", "render", "App/View.swift"))
      .addEntity(entity("method:Presenter.load", "method", "load", "App/Presenter.swift"))
      .addEntity(entity("method:Repository.load", "method", "load", "Core/Repository.swift"))
      .addEdge(edge("file:App/View.swift", "method:View.render", "defines"))
      .addEdge(
        edge("method:View.render", "method:Presenter.load", "calls", { file: "App/View.swift" }),
      )
      .addEdge(
        edge("method:Presenter.load", "method:Repository.load", "calls", {
          file: "App/Presenter.swift",
        }),
      );

    expect(graph.removeEdgesForFiles(["App/Presenter.swift"])).toEqual({ deletedEdges: 2 });
    expect(graph.findOutgoing("method:Presenter.load", "calls")).toEqual([]);

    expect(graph.removeEntitiesForFiles(["App/View.swift"])).toEqual({
      deletedEntities: 2,
      deletedEdges: 1,
      entityIds: ["file:App/View.swift", "method:View.render"],
    });
    expect(graph.findEntity("method:View.render")).toBeNull();
    expect(graph.edges).toEqual([]);

    expect(graph.removeEntity("method:Repository.load")).toEqual({
      deletedEntities: 1,
      deletedEdges: 0,
      entityIds: ["method:Repository.load"],
    });
  });

  it("supports property and recipe entities with legacy pattern and candidate relationships", () => {
    const graph = new EngineeringEntityGraph()
      .addEntity(entity("property:Store.cache", "property", "cache"))
      .addEntity(entity("class:Store", "class", "Store"))
      .addEdge(edge("property:Store.cache", "class:Store", "is_part_of"))
      .addPatternStats({
        Repository: {
          count: 1,
          files: ["Core/Store.swift"],
          instances: [{ className: "Store", file: "Core/Store.swift" }],
        },
      })
      .addCandidateRelations([
        {
          title: "Repository Contract",
          relations: {
            prerequisite: [{ target: "Storage Contract", description: "must exist first" }],
            implements: [{ target: "Serializable Contract" }],
          },
        },
      ]);

    expect(graph.countByType()).toMatchObject({
      recipe: 3,
      pattern: 1,
      property: 1,
    });
    expect(graph.findOutgoing("class:Store", "uses_pattern")).toEqual([
      expect.objectContaining({ to: "pattern:Repository" }),
    ]);
    expect(graph.findOutgoing("recipe:Repository Contract", "depends_on")).toEqual([
      expect.objectContaining({
        to: "recipe:Storage Contract",
        metadata: expect.objectContaining({ description: "must exist first" }),
      }),
    ]);
    expect(graph.findOutgoing("recipe:Repository Contract", "conforms")).toEqual([
      expect.objectContaining({ to: "recipe:Serializable Contract" }),
    ]);
    expect(graph.findOutgoing("property:Store.cache", "is_part_of")).toEqual([
      expect.objectContaining({ to: "class:Store" }),
    ]);
  });
});

function fixtureCodeGraph(): EngineeringCodeGraphReader {
  return Object.assign(new EmptyEngineeringCodeGraph(), {
    getFileSymbols: (relativePath: string) => {
      if (relativePath === "App/MainView.swift") {
        return {
          path: relativePath,
          languageId: "swift",
          classes: ["MainView"],
          protocols: [],
          categories: [],
          imports: [],
          exports: [],
          callSites: [],
          references: [],
          patterns: [],
          metrics: null,
        };
      }
      if (relativePath === "Core/Model.swift") {
        return {
          path: relativePath,
          languageId: "swift",
          classes: ["Model"],
          protocols: ["Renderable"],
          categories: [],
          imports: [],
          exports: [],
          callSites: [],
          references: [],
          patterns: [],
          metrics: null,
        };
      }
      if (relativePath === "Core/Model+Preview.swift") {
        return {
          path: relativePath,
          languageId: "swift",
          classes: [],
          protocols: [],
          categories: ["MainView(Preview)"],
          imports: [],
          exports: [],
          callSites: [],
          references: [],
          patterns: [],
          metrics: null,
        };
      }
      return null;
    },
    getClassInfo: (className: string) => {
      if (className === "MainView") {
        return {
          name: "MainView",
          filePath: "App/MainView.swift",
          line: null,
          endLine: null,
          superClass: "BaseView",
          protocols: ["Renderable"],
          properties: [],
          methods: [],
          imports: [],
        };
      }
      if (className === "Model") {
        return {
          name: "Model",
          filePath: "Core/Model.swift",
          line: null,
          endLine: null,
          superClass: null,
          protocols: [],
          properties: [],
          methods: [],
          imports: [],
        };
      }
      return null;
    },
  });
}

function entity(
  id: string,
  type: Parameters<EngineeringEntityGraph["listByType"]>[0],
  name: string,
  filePath: string | null = null,
) {
  return {
    id,
    type,
    name,
    filePath,
    line: null,
    metadata: {},
  };
}

function edge(from: string, to: string, relation: string, metadata: Record<string, unknown> = {}) {
  return {
    from,
    to,
    relation,
    weight: 1,
    metadata,
  };
}

function callEdge(
  overrides: Partial<{
    caller: string;
    callee: string;
    callType: string;
    resolveMethod: string;
    line: number | null;
    filePath: string;
    isAwait: boolean;
    argCount: number;
    sourceFilePath: string | null;
    targetFilePath: string | null;
  }>,
) {
  return {
    caller: "Caller.run",
    callee: "Callee.run",
    callType: "method",
    resolveMethod: "summary",
    line: 7,
    filePath: "App/File.swift",
    isAwait: false,
    argCount: 0,
    sourceFilePath: null,
    targetFilePath: null,
    ...overrides,
  };
}

function dataFlowEdge(
  overrides: Partial<{
    from: string;
    to: string;
    flowType: string;
    direction: string;
    confidence: number | null;
    filePath: string | null;
    line: number | null;
    source: string | null;
    sink: string | null;
  }>,
) {
  return {
    from: "Source.run",
    to: "Sink.run",
    flowType: "argument",
    direction: "forward",
    confidence: 0.7,
    filePath: "App/File.swift",
    line: 7,
    source: null,
    sink: null,
    ...overrides,
  };
}
