import { describe, expect, it } from "vitest";
import { EngineeringCodeGraph } from "./EngineeringCodeGraph.js";
import type { EngineeringCodeAstSummaryInput } from "./EngineeringCodeGraphModel.js";

const astSummary: EngineeringCodeAstSummaryInput = {
  fileSummaries: [
    {
      file: "Sources/App/AppDelegate.swift",
      lang: "swift",
      classes: [
        {
          name: "BaseController",
          line: 3,
          protocols: ["Renderable"],
          methods: [{ name: "render", selector: "render()", line: 8, returnType: "Void" }],
          properties: [{ name: "title", type: "String", line: 5, attributes: ["public"] }],
        },
        {
          name: "HomeController",
          line: 20,
          superclass: "BaseController",
          protocols: ["Trackable"],
          methods: [{ name: "render", selector: "render()", line: 28, returnType: "Void" }],
        },
        {
          name: "DetailController",
          line: 40,
          superClass: "HomeController",
          methods: [{ name: "renderDetail", selector: "renderDetail()", line: 44 }],
        },
      ],
      protocols: [
        {
          name: "Renderable",
          line: 1,
          requiredMethods: [{ name: "render", selector: "render()", line: 2 }],
        },
        {
          name: "Trackable",
          line: 15,
          inherits: ["Renderable"],
          optionalMethods: [{ name: "track", selector: "track()", line: 17 }],
        },
      ],
      exports: ["HomeController"],
      callSites: [
        {
          callee: "data",
          callerClass: "HomeController",
          callerMethod: "render",
          callType: "method",
          receiver: "URLSession.shared",
          argCount: 1,
          line: 31,
          snippet: "URLSession.shared.data(for: request)",
        },
        {
          callee: "renderDetail",
          callerClass: "HomeController",
          callerMethod: "render",
          callType: "method",
          receiver: "detail",
          receiverType: "DetailController",
          line: 32,
        },
      ],
      references: [
        {
          name: "LegacyAPI",
          kind: "identifier",
          line: 55,
          context: "dealloc",
          snippet: "LegacyAPI.shared.release()",
        },
      ],
      patterns: [{ type: "Singleton", className: "HomeController", line: 30, confidence: 0.9 }],
      metrics: {
        methodCount: 3,
        avgBodyLines: 8,
        maxComplexity: 2,
        maxNestingDepth: 1,
        longMethods: [],
        complexMethods: [],
      },
      imports: ["UIKit"],
    },
    {
      file: "Sources/App/HomeController+Analytics.swift",
      lang: "swift",
      categories: [
        {
          className: "HomeController",
          categoryName: "Analytics",
          line: 4,
          protocols: ["AnalyticsReporting"],
          methods: [{ name: "track", selector: "track()", line: 9 }],
        },
      ],
      protocols: [
        { name: "AnalyticsReporting", requiredMethods: [{ name: "track", selector: "track()" }] },
      ],
      callSites: [
        {
          callee: "submit",
          callerClass: "HomeController",
          callerMethod: "track",
          callType: "method",
          receiver: "analytics",
          receiverType: "AnalyticsClient",
          argCount: 1,
          line: 10,
        },
      ],
    },
  ],
};

describe("EngineeringCodeGraph", () => {
  it("indexes inheritance and descendants", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(graph.getInheritanceChain("DetailController")).toEqual([
      "DetailController",
      "HomeController",
      "BaseController",
    ]);
    expect(graph.getSubclasses("BaseController")).toEqual(["HomeController"]);
    expect(graph.getAllDescendants("BaseController")).toEqual([
      "DetailController",
      "HomeController",
    ]);
  });

  it("indexes protocol conformers from classes, inherited protocols, and categories", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(graph.getProtocolInfo("Trackable")?.conformers).toEqual(["HomeController"]);
    expect(graph.getProtocolInfo("Renderable")?.conformers).toEqual([
      "BaseController",
      "HomeController",
    ]);
    expect(graph.getProtocolInfo("AnalyticsReporting")?.conformers).toEqual(["HomeController"]);
  });

  it("returns category extensions and merged class methods", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(graph.getCategoryExtensions("HomeController")).toMatchObject([
      {
        className: "HomeController",
        categoryName: "Analytics",
        methods: [{ name: "track", selector: "track()" }],
      },
    ]);
    expect(graph.getClassMethods("HomeController").map((method) => method.name)).toEqual([
      "render",
      "track",
    ]);
  });

  it("finds method overrides in descendants", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(graph.getMethodOverrides("BaseController", "render")).toMatchObject([
      {
        className: "HomeController",
        method: { name: "render", selector: "render()" },
      },
    ]);
  });

  it("reports overview, file symbols, and searchable names", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(graph.getOverview()).toEqual({
      totalFiles: 2,
      totalClasses: 3,
      totalProtocols: 3,
      totalCategories: 1,
      totalMethods: 7,
      topLevelModules: ["Sources"],
      entryPoints: ["Sources/App/AppDelegate.swift"],
      classesPerModule: { Sources: 3 },
    });
    expect(graph.getFileSymbols("Sources/App/HomeController+Analytics.swift")).toMatchObject({
      categories: ["HomeController(Analytics)"],
      protocols: ["AnalyticsReporting"],
    });
    expect(graph.getAllFilePaths()).toEqual([
      "Sources/App/AppDelegate.swift",
      "Sources/App/HomeController+Analytics.swift",
    ]);
    expect(graph.searchClasses("controller")).toEqual([
      "BaseController",
      "DetailController",
      "HomeController",
    ]);
    expect(graph.getAllProtocolNames()).toEqual(["AnalyticsReporting", "Renderable", "Trackable"]);
  });

  it("round-trips through toJSON/fromJSON", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);
    const restored = EngineeringCodeGraph.fromJSON(graph.toJSON());

    expect(restored.getAllClassNames()).toEqual(graph.getAllClassNames());
    expect(restored.getProtocolInfo("Renderable")?.conformers).toEqual([
      "BaseController",
      "HomeController",
    ]);
    expect(restored.getCategoryExtensions("HomeController")).toEqual(
      graph.getCategoryExtensions("HomeController"),
    );
    expect(restored.getOverview()).toEqual(graph.getOverview());
  });

  it("supports incremental add, update, and delete with full cleanup", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(
      graph.upsertFileSummary({
        file: "Sources/App/ProfileController.swift",
        lang: "swift",
        classes: [
          {
            name: "ProfileController",
            superclass: "BaseController",
            methods: [{ name: "render", selector: "render()", line: 8 }],
          },
        ],
        callSites: [
          {
            callee: "render",
            callerClass: "ProfileController",
            callerMethod: "render",
            callType: "method",
            receiver: "super",
            line: 9,
          },
        ],
      }),
    ).toBe("added");
    expect(graph.getSubclasses("BaseController")).toEqual(["HomeController", "ProfileController"]);

    expect(
      graph.incrementalUpdate({
        fileSummaries: [
          {
            file: "Sources/App/AppDelegate.swift",
            lang: "swift",
            classes: [
              {
                name: "BaseController",
                line: 3,
                protocols: ["Renderable"],
                methods: [{ name: "render", selector: "render()", line: 8 }],
              },
              {
                name: "HomeController",
                line: 20,
                superclass: "BaseController",
                protocols: ["Trackable"],
                methods: [{ name: "renderHome", selector: "renderHome()", line: 28 }],
              },
            ],
            protocols: [
              {
                name: "Renderable",
                requiredMethods: [{ name: "render", selector: "render()" }],
              },
              { name: "Trackable", inherits: ["Renderable"] },
            ],
            callSites: [
              {
                callee: "renderHome",
                callerClass: "HomeController",
                callerMethod: "renderHome",
                callType: "method",
                receiver: "self",
                line: 30,
              },
            ],
          },
        ],
      }),
    ).toEqual({ added: 0, updated: 1, deleted: 0 });
    expect(graph.getClassInfo("DetailController")).toBeNull();
    expect(graph.getCallEdgesForSymbol("renderDetail")).toEqual([]);
    expect(graph.getClassMethods("HomeController").map((method) => method.name)).toEqual([
      "renderHome",
      "track",
    ]);

    expect(graph.incrementalUpdate([], ["Sources/App/HomeController+Analytics.swift"])).toEqual({
      added: 0,
      updated: 0,
      deleted: 1,
    });
    expect(graph.getCategoryExtensions("HomeController")).toEqual([]);
    expect(graph.getProtocolInfo("AnalyticsReporting")).toBeNull();
    expect(graph.getCallEdgesForSymbol("AnalyticsClient")).toEqual([]);
  });

  it("queries call graph and data-flow edges by file and symbol scope", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(graph.getCallEdgesByFile("Sources/App/AppDelegate.swift")).toMatchObject([
      { callee: "URLSession.shared.data", argCount: 1 },
      { callee: "DetailController.renderDetail" },
    ]);
    expect(graph.getCallEdgesForClass("HomeController")).toHaveLength(3);
    expect(
      graph.getCallEdgesForMethod("HomeController", "render").map((edge) => edge.callee),
    ).toEqual(["URLSession.shared.data", "DetailController.renderDetail"]);

    expect(
      graph.getDataFlowEdges({ source: "HomeController.render", sink: "URLSession" }),
    ).toMatchObject([{ flowType: "argument", direction: "forward" }]);
    expect(graph.getDataFlowEdges({ from: "AnalyticsClient.submit" })).toMatchObject([
      { flowType: "return-value", direction: "backward" },
    ]);
  });

  it("provides Guard AST query placeholders from indexed summaries", () => {
    const graph = EngineeringCodeGraph.fromAstSummary(astSummary);

    expect(graph.findCallExpressions("URLSession.shared")).toMatchObject([
      {
        filePath: "Sources/App/AppDelegate.swift",
        line: 31,
        enclosingClass: "HomeController",
      },
    ]);
    expect(graph.findPatternInContext("LegacyAPI", { forbiddenContext: "dealloc" })).toMatchObject([
      {
        filePath: "Sources/App/AppDelegate.swift",
        line: 55,
        context: "dealloc",
      },
    ]);
    expect(graph.checkProtocolConformance("HomeController", "Renderable")).toEqual({
      conforms: true,
      classFound: true,
      classDeclLine: 20,
      direct: false,
      viaCategory: false,
      viaInheritedProtocol: true,
    });
    expect(graph.checkProtocolConformance("HomeController", "AnalyticsReporting")).toMatchObject({
      conforms: true,
      viaCategory: true,
    });
  });
});
