import { describe, expect, it } from "vitest";
import type { MainlineProjectIntelligenceArtifact } from "../graph/index.js";
import {
  buildEngineeringWorkflowInput,
  InMemoryMainlineEngineeringWorkflowArtifactStore,
  MainlineEngineeringWorkflowCompileAdapter,
  type MainlineEngineeringWorkflowCompileAdapterPort,
  MainlineProjectIntelligenceRunner,
} from "./index.js";

describe("project intelligence engineering workflow adapter", () => {
  it("projects mainline artifact facts into the isolated engineering workflow", async () => {
    const artifact = fixtureArtifact();
    const result = await new MainlineEngineeringWorkflowCompileAdapter().run({
      projectRoot: "/repo",
      artifact,
      files: fixtureFiles(),
      computedAt: 100,
    });

    expect(result.status).toBe("success");
    expect(result.workflowResult?.artifact.targets).toEqual([
      expect.objectContaining({ name: "repo", language: "typescript" }),
    ]);
    expect(result.workflowResult?.artifact.files.map((file) => file.relativePath)).toEqual([
      "src/app.ts",
      "src/util.ts",
    ]);
    expect(result.workflowResult?.artifact.dependencyGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "file:src/app.ts",
          to: "file:src/util.ts",
          type: "imports",
        }),
        expect.objectContaining({
          from: "file:src/app.ts",
          to: "external:react",
          scope: "external",
        }),
      ]),
    );
    expect(result.workflowResult?.artifact.callGraph).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caller: "App.render",
          callee: "helper",
          filePath: "src/app.ts",
        }),
      ]),
    );
    expect(result.workflowResult?.artifact.optionalStage.status).toBe("disabled");
  });

  it("keeps the runner sidecar opt-in and leaves the mainline artifact path unchanged", async () => {
    const calls: string[] = [];
    const fakeAdapter: MainlineEngineeringWorkflowCompileAdapterPort = {
      async run(request) {
        calls.push(request.projectRoot);
        return {
          status: "success",
          input: buildEngineeringWorkflowInput(request),
          diagnostics: [],
        };
      },
    };
    const runner = new MainlineProjectIntelligenceRunner({
      engineeringWorkflowAdapter: fakeAdapter,
    });

    const withoutSidecar = await runner.run({
      projectRoot: "/repo",
      files: fixtureFiles(),
      materialize: false,
    });
    const withSidecar = await runner.run({
      projectRoot: "/repo",
      files: fixtureFiles(),
      materialize: false,
      engineeringWorkflow: true,
    });

    expect(calls).toEqual(["/repo"]);
    expect(withoutSidecar.engineeringWorkflow).toBeUndefined();
    expect(withoutSidecar.artifact.files.map((file) => file.path)).toEqual(
      withSidecar.artifact.files.map((file) => file.path),
    );
    expect(withSidecar.engineeringWorkflow?.status).toBe("success");
  });

  it("isolates sidecar adapter failures from the verified project intelligence artifact", async () => {
    const runner = new MainlineProjectIntelligenceRunner({
      engineeringWorkflowAdapter: {
        async run() {
          throw new Error("sidecar boom");
        },
      },
    });

    const result = await runner.run({
      projectRoot: "/repo",
      files: fixtureFiles(),
      materialize: false,
      engineeringWorkflow: true,
    });

    expect(result.artifact.files.map((file) => file.path)).toEqual(["src/app.ts", "src/util.ts"]);
    expect(result.engineeringWorkflow).toEqual(
      expect.objectContaining({
        status: "failed",
        diagnostics: [
          expect.objectContaining({
            source: "adapter",
            severity: "error",
            cause: "sidecar boom",
          }),
        ],
      }),
    );
  });

  it("persists sidecar artifacts when a workflow artifact store is provided", async () => {
    const engineeringWorkflowArtifactStore = new InMemoryMainlineEngineeringWorkflowArtifactStore();
    const runner = new MainlineProjectIntelligenceRunner({
      engineeringWorkflowArtifactStore,
    });

    const result = await runner.run({
      projectRoot: "/repo",
      files: fixtureFiles(),
      materialize: false,
      engineeringWorkflow: true,
    });
    const stored = await engineeringWorkflowArtifactStore.load();

    expect(result.engineeringWorkflow?.status).toBe("success");
    expect(stored?.workflowArtifact.projectRoot).toBe("/repo");
    expect(stored?.codeGraph.files.map((file) => file.path)).toEqual(["src/app.ts", "src/util.ts"]);
    expect(stored?.entityGraph.entities.length).toBeGreaterThan(0);
    expect(stored?.panoramaSnapshot?.overview.totalFileCount).toBe(2);
  });
});

function fixtureFiles() {
  return [
    {
      path: "src/app.ts",
      content:
        'import React from "react";\nimport { helper } from "./util";\nexport class App { render() { return helper(); } }\n',
      languageId: "typescript",
    },
    {
      path: "src/util.ts",
      content: "export function helper() { return true; }\n",
      languageId: "typescript",
    },
  ];
}

function fixtureArtifact(): MainlineProjectIntelligenceArtifact {
  return {
    projectRoot: "/repo",
    generatedAt: 1,
    files: [
      {
        path: "src/app.ts",
        languageId: "typescript",
        status: "parsed",
        contentHash: "app",
        symbolIds: ["symbol:src/app.ts::App"],
      },
      {
        path: "src/util.ts",
        languageId: "typescript",
        status: "parsed",
        contentHash: "util",
        symbolIds: ["symbol:src/util.ts::helper"],
      },
    ],
    symbols: [
      {
        id: "symbol:src/app.ts::App",
        fqn: "src/app.ts::App",
        name: "App",
        kind: "class",
        file: "src/app.ts",
        languageId: "typescript",
        line: 3,
        containerName: null,
        isExported: true,
      },
      {
        id: "symbol:src/util.ts::helper",
        fqn: "src/util.ts::helper",
        name: "helper",
        kind: "function",
        file: "src/util.ts",
        languageId: "typescript",
        line: 1,
        containerName: null,
        isExported: true,
      },
    ],
    callSites: [],
    projectGraph: {
      nodes: [
        { id: "file:src/app.ts", kind: "file", path: "src/app.ts", languageId: "typescript" },
        { id: "file:src/util.ts", kind: "file", path: "src/util.ts", languageId: "typescript" },
        {
          id: "symbol:src/app.ts#App",
          kind: "symbol",
          path: "src/app.ts",
          symbol: "App",
        },
      ],
      edges: [
        { from: "file:src/app.ts", to: "file:src/util.ts", kind: "imports", specifier: "./util" },
        { from: "file:src/app.ts", to: "symbol:src/app.ts#App", kind: "declares" },
      ],
      externalDependencies: [{ fromPath: "src/app.ts", specifier: "react", kind: "imports" }],
      unresolvedDependencies: [],
      cycles: [],
    },
    semanticEdges: [],
    astProjectSummary: {
      lang: "typescript",
      fileCount: 2,
      classes: [{ name: "App", file: "src/app.ts" }],
      protocols: [],
      categories: [],
      inheritanceGraph: [],
      patternStats: {},
      projectMetrics: {},
      fileSummaries: [
        {
          file: "src/app.ts",
          lang: "typescript",
          imports: [{ path: "react" }, { path: "./util" }],
          classes: [{ name: "App", methods: [{ name: "render", line: 3 }] }],
          callSites: [
            {
              callee: "helper",
              callerClass: "App",
              callerMethod: "render",
              callType: "function",
              argCount: 0,
              line: 3,
            },
          ],
        },
        {
          file: "src/util.ts",
          lang: "typescript",
          methods: [{ name: "helper", line: 1 }],
        },
      ],
    },
    callGraph: {
      callEdges: [
        {
          caller: "App.render",
          callee: "helper",
          callType: "function",
          resolveMethod: "legacy-direct",
          line: 3,
          file: "src/app.ts",
          isAwait: false,
          argCount: 0,
        },
      ],
      dataFlowEdges: [],
      stats: {},
    },
  };
}
