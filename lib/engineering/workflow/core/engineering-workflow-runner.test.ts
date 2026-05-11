import { describe, expect, it } from "vitest";
import type {
  EngineeringDiscoverer,
  EngineeringTarget,
} from "../../foundation/EngineeringCoreTypes.js";
import type {
  EngineeringWorkflowSnapshotStore,
  EngineeringWorkflowSnapshotWriteInput,
} from "../cache/EngineeringWorkflowCacheTypes.js";
import {
  buildEngineeringWorkflowSnapshot,
  InMemoryEngineeringWorkflowSnapshotStore,
} from "../cache/EngineeringWorkflowSnapshotStore.js";
import { EngineeringWorkflowRunner } from "../EngineeringWorkflowRunner.js";
import type { EngineeringWorkflowDiscoveryResult } from "../EngineeringWorkflowTypes.js";

const dimensions = [
  "project-profile",
  "code-standard",
  "architecture",
  "module-export-scan",
  "code-pattern",
  "best-practice",
  "event-and-data-flow",
];

describe("EngineeringWorkflowRunner core phases", () => {
  it("runs mixed Node, Swift, and Python injected facts into graph and panorama artifacts", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: mixedDiscovery(),
      astSummaries: {
        fileSummaries: [
          {
            file: "apps/web/src/App.ts",
            lang: "typescript",
            imports: [{ path: "@demo/core" }],
            classes: [{ name: "WebApp", methods: [{ name: "render", line: 3 }] }],
            callSites: [
              {
                callee: "loadCore",
                callerClass: "WebApp",
                callerMethod: "render",
                callType: "function",
                argCount: 1,
                line: 4,
              },
            ],
          },
          {
            file: "Sources/Core/Core.swift",
            lang: "swift",
            classes: [{ name: "CoreService", methods: [{ name: "loadCore", line: 2 }] }],
          },
          {
            file: "pkg/service.py",
            lang: "python",
            imports: [{ path: "fastapi" }],
            methods: [{ name: "handle", line: 2 }],
          },
        ],
      },
      fileContents: {
        "apps/web/src/App.ts": "import '@demo/core';",
        "Sources/Core/Core.swift": "final class CoreService {}",
        "pkg/service.py": "from fastapi import FastAPI",
      },
      importFacts: [
        { filePath: "apps/web/src/App.ts", specifier: "Core" },
        { filePath: "pkg/service.py", specifier: "fastapi" },
      ],
      computedAt: 100,
    });

    expect(result.status).toBe("success");
    expect(result.artifact.targets.map((target) => target.name)).toEqual([
      "web",
      "Core",
      "py-service",
    ]);
    expect(result.artifact.files.map((file) => file.relativePath)).toEqual([
      "apps/web/src/App.ts",
      "Sources/Core/Core.swift",
      "pkg/service.py",
    ]);
    expect(result.artifact.codeGraph.overview).toMatchObject({
      totalFiles: 3,
      totalClasses: 2,
      totalMethods: 2,
    });
    expect(result.artifact.callGraph.length).toBeGreaterThan(0);
    expect(result.artifact.dataFlow.length).toBeGreaterThan(0);
    expect(result.artifact.entityGraph.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(["web", "Core", "py-service", "WebApp", "CoreService"]),
    );
    expect(result.artifact.panoramaSnapshot?.overview).toEqual(
      expect.objectContaining({
        moduleCount: 3,
        externalDependencyCount: 2,
        totalFileCount: 3,
      }),
    );
    expect(result.artifact.optionalStage.status).toBe("success");
    expect(
      result.artifact.optionalStage.enhancementSignals.map((signal) => signal.packId),
    ).toContain("fastapi");
    expect(result.artifact.dimensionFileRefs.length).toBeGreaterThan(0);
  });

  it("records the phase order", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: mixedDiscovery(),
      computedAt: 200,
    });

    expect(result.phases.map((phase) => phase.name)).toEqual([
      "discover",
      "cache",
      "collectFacts",
      "buildGraphs",
      "panorama",
      "optional",
    ]);
  });

  it("records a disabled optional phase without running enhancement or guard work", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/a.ts"]),
      fileContents: { "src/a.ts": "export {}" },
      optionalStage: false,
    });

    expect(result.artifact.optionalStage.status).toBe("disabled");
    expect(result.artifact.optionalStage.result).toBeNull();
    expect(result.phases.find((phase) => phase.name === "optional")).toEqual(
      expect.objectContaining({
        status: "skipped",
        summary: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(result.capabilities.optionalStage).toBe(false);
  });

  it("reports empty guard diagnostics while still completing the optional phase", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/a.ts"]),
      fileContents: { "src/a.ts": "export {}" },
    });

    expect(result.artifact.optionalStage.status).toBe("success");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        phase: "optional",
        code: "optional.guard.empty",
      }),
    );
    expect(result.phases.find((phase) => phase.name === "optional")?.status).toBe("success");
  });

  it("mounts React and Node enhancement signals plus dimension refs into the runner artifact", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/App.tsx", "src/server.ts"]),
      fileContents: {
        "src/App.tsx": "import React from 'react'; export function App(){ return null; }",
        "src/server.ts": "import express from 'express'; export const app = express();",
      },
      importFacts: [
        { filePath: "src/App.tsx", specifier: "react" },
        { filePath: "src/server.ts", specifier: "express" },
      ],
    });

    expect(result.artifact.optionalStage.enhancementSignals.map((signal) => signal.packId)).toEqual(
      expect.arrayContaining(["react", "node-server"]),
    );
    expect(result.artifact.optionalStage.dimensionGates.map((gate) => gate.dimensionId)).toEqual(
      expect.arrayContaining(["hook-pattern-scan", "middleware-analysis"]),
    );
    expect(result.artifact.dimensionFileRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: "src/App.tsx", source: "enhancement-signal" }),
        expect.objectContaining({ filePath: "src/server.ts", source: "enhancement-signal" }),
      ]),
    );
  });

  it("records guard callback findings and fails soft when a callback throws", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/App.tsx"]),
      fileContents: {
        "src/App.tsx": "import React from 'react'; export function App(){ return null; }",
      },
      importFacts: [{ filePath: "src/App.tsx", specifier: "react" }],
      optionalStage: {
        guardCallbacks: [
          ({ file }) => ({
            ruleId: "callback-rule",
            severity: "warning",
            message: "callback finding",
            filePath: file.relativePath ?? file.path,
            source: "test-callback",
          }),
          () => {
            throw new Error("callback boom");
          },
        ],
      },
    });

    expect(result.status).toBe("partial");
    expect(result.artifact.optionalStage.status).toBe("partial");
    expect(result.artifact.optionalStage.guardFindings).toContainEqual(
      expect.objectContaining({
        ruleId: "callback-rule",
        filePath: "src/App.tsx",
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        phase: "optional",
        code: "optional.guard.callback-failed",
        message: expect.stringContaining("callback boom"),
      }),
    );
    expect(result.phases.find((phase) => phase.name === "optional")?.summary).toEqual(
      expect.objectContaining({ reAuditDiagnostics: expect.any(Number) }),
    );
  });

  it("keeps partial success when target file discovery fails", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoverer: partialDiscoverer(),
      computedAt: 300,
    });

    expect(result.status).toBe("partial");
    expect(result.phases.find((phase) => phase.name === "discover")).toEqual(
      expect.objectContaining({
        status: "partial",
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        phase: "discover",
        severity: "warning",
        message: "Target file discovery failed for Broken",
      }),
    );
    expect(result.artifact.files.map((file) => file.relativePath)).toEqual(["src/index.ts"]);
    expect(result.artifact.panoramaSnapshot?.overview.totalFileCount).toBe(1);
  });

  it("integrates panorama snapshots and generated artifact blacklist fail-soft", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: {
        targets: [target("App", "app", "typescript")],
        files: [
          file("src/index.ts", "typescript", "App"),
          file("AGENTS.md", "markdown", "App"),
          file(".cursor/rules/project.mdc", "markdown", "App"),
        ],
        dependencyGraph: { nodes: [{ id: "App", type: "app" }], edges: [] },
      },
      astSummaries: {
        fileSummaries: [{ file: "src/index.ts", lang: "typescript", methods: [{ name: "main" }] }],
      },
      computedAt: 400,
    });

    expect(result.status).toBe("partial");
    expect(result.artifact.files.map((item) => item.relativePath)).toEqual(["src/index.ts"]);
    expect(result.artifact.generatedArtifactBlacklist).toEqual([
      "AGENTS.md",
      ".cursor/rules/project.mdc",
    ]);
    expect(result.artifact.panoramaSnapshot).toEqual(
      expect.objectContaining({
        projectRoot: "/repo",
        computedAt: 400,
        overview: expect.objectContaining({
          moduleCount: 1,
          totalFileCount: 1,
        }),
      }),
    );
  });

  it("plans a full rescan when baseline change ratio exceeds the incremental threshold", async () => {
    const store = new InMemoryEngineeringWorkflowSnapshotStore({
      snapshots: [
        buildEngineeringWorkflowSnapshot({
          id: "baseline",
          projectRoot: "/repo",
          allFiles: [
            { relativePath: "src/a.ts", content: "old" },
            { relativePath: "src/b.ts", content: "old" },
          ],
        }),
      ],
    });

    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/a.ts", "src/b.ts"]),
      fileContents: {
        "src/a.ts": "new",
        "src/b.ts": "new",
      },
      currentFingerprints: [
        { relativePath: "src/a.ts", content: "new" },
        { relativePath: "src/b.ts", content: "new" },
      ],
      snapshotStore: store,
      incremental: { enabled: true, allDimensions: dimensions },
    });

    expect(result.incrementalPlan?.mode).toBe("full-rescan");
    expect(result.artifact.files.map((item) => item.relativePath)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(result.snapshot?.saved).toBe(true);
  });

  it("skips fact, graph, and panorama phases when baseline diff is unchanged", async () => {
    let optionalCallbackCalls = 0;
    const store = new InMemoryEngineeringWorkflowSnapshotStore({
      snapshots: [
        buildEngineeringWorkflowSnapshot({
          id: "baseline",
          projectRoot: "/repo",
          allFiles: [{ relativePath: "src/a.ts", content: "same" }],
        }),
      ],
    });

    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/a.ts"]),
      fileContents: { "src/a.ts": "same" },
      currentFingerprints: [{ relativePath: "src/a.ts", content: "same" }],
      snapshotStore: store,
      incremental: { enabled: true, allDimensions: dimensions },
      optionalStage: {
        guardCallbacks: [
          () => {
            optionalCallbackCalls += 1;
            return null;
          },
        ],
      },
    });

    expect(result.incrementalPlan?.mode).toBe("skip");
    expect(result.phases.find((phase) => phase.name === "collectFacts")?.status).toBe("skipped");
    expect(result.phases.find((phase) => phase.name === "buildGraphs")?.status).toBe("skipped");
    expect(result.phases.find((phase) => phase.name === "panorama")?.status).toBe("skipped");
    expect(result.phases.find((phase) => phase.name === "optional")?.status).toBe("skipped");
    expect(result.artifact.optionalStage.status).toBe("skipped");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        phase: "optional",
        message: expect.stringContaining("cached optional artifacts require an external adapter"),
      }),
    );
    expect(optionalCallbackCalls).toBe(0);
    expect(result.snapshot?.saved).toBe(true);
  });

  it("runs panorama-only refresh for pure file moves", async () => {
    const store = new InMemoryEngineeringWorkflowSnapshotStore({
      snapshots: [
        buildEngineeringWorkflowSnapshot({
          id: "baseline",
          projectRoot: "/repo",
          allFiles: [{ relativePath: "src/old.ts", content: "same" }],
        }),
      ],
    });

    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/new.ts"]),
      fileContents: { "src/new.ts": "same" },
      currentFingerprints: [{ relativePath: "src/new.ts", content: "same" }],
      snapshotStore: store,
      incremental: { enabled: true, allDimensions: dimensions },
    });

    expect(result.incrementalPlan?.mode).toBe("panorama-only");
    expect(result.phases.find((phase) => phase.name === "buildGraphs")?.status).toBe("skipped");
    expect(result.phases.find((phase) => phase.name === "panorama")?.status).toBe("success");
    expect(result.artifact.panoramaSnapshot?.overview.totalFileCount).toBe(1);
  });

  it("runs targeted rescan and reports that unaffected facts require an external adapter", async () => {
    const store = new InMemoryEngineeringWorkflowSnapshotStore({
      snapshots: [
        buildEngineeringWorkflowSnapshot({
          id: "baseline",
          projectRoot: "/repo",
          allFiles: [
            { relativePath: "packages/app/src/service.ts", content: "old" },
            { relativePath: "packages/core/src/a.ts", content: "same" },
            { relativePath: "packages/core/src/b.ts", content: "same" },
            { relativePath: "packages/core/src/c.ts", content: "same" },
            { relativePath: "packages/core/src/d.ts", content: "same" },
          ],
          dimensionStats: {
            "event-and-data-flow": {
              referencedFilesList: ["packages/app/src/service.ts"],
            },
          },
        }),
      ],
    });

    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor([
        "packages/app/src/service.ts",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
      ]),
      fileContents: {
        "packages/app/src/service.ts": "new",
        "packages/core/src/a.ts": "same",
        "packages/core/src/b.ts": "same",
        "packages/core/src/c.ts": "same",
        "packages/core/src/d.ts": "same",
      },
      currentFingerprints: [
        { relativePath: "packages/app/src/service.ts", content: "new" },
        { relativePath: "packages/core/src/a.ts", content: "same" },
        { relativePath: "packages/core/src/b.ts", content: "same" },
        { relativePath: "packages/core/src/c.ts", content: "same" },
        { relativePath: "packages/core/src/d.ts", content: "same" },
      ],
      snapshotStore: store,
      incremental: { enabled: true, allDimensions: dimensions },
    });

    expect(result.incrementalPlan?.mode).toBe("targeted-rescan");
    expect(result.artifact.files.map((item) => item.relativePath)).toEqual([
      "packages/app/src/service.ts",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        phase: "cache",
        severity: "warning",
        message: expect.stringContaining("cannot reuse unaffected historical facts"),
      }),
    );
  });

  it("reports baseline missing and still saves a new full snapshot", async () => {
    const store = new InMemoryEngineeringWorkflowSnapshotStore();

    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/a.ts"]),
      fileContents: { "src/a.ts": "same" },
      currentFingerprints: [{ relativePath: "src/a.ts", content: "same" }],
      snapshotStore: store,
      incremental: { enabled: true, allDimensions: dimensions },
    });

    expect(result.incrementalPlan?.mode).toBe("full-rescan");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        phase: "cache",
        code: "baseline_missing",
      }),
    );
    expect(result.snapshot?.saved).toBe(true);
  });

  it("keeps partial results when snapshot save fails", async () => {
    const result = await new EngineeringWorkflowRunner().run({
      projectRoot: "/repo",
      discoveryResult: discoveryFor(["src/a.ts"]),
      fileContents: { "src/a.ts": "same" },
      currentFingerprints: [{ relativePath: "src/a.ts", content: "same" }],
      snapshotStore: new FailingSnapshotStore(),
      incremental: { enabled: true, allDimensions: dimensions },
    });

    expect(result.status).toBe("partial");
    expect(result.artifact.files.map((item) => item.relativePath)).toEqual(["src/a.ts"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        phase: "cache",
        code: "snapshot_write_failed",
      }),
    );
    expect(result.snapshot?.saved).toBe(false);
  });
});

function mixedDiscovery(): EngineeringWorkflowDiscoveryResult {
  return {
    targets: [
      target("web", "app", "typescript"),
      target("Core", "library", "swift"),
      target("py-service", "service", "python"),
    ],
    files: [
      file("apps/web/src/App.ts", "typescript", "web"),
      file("Sources/Core/Core.swift", "swift", "Core"),
      file("pkg/service.py", "python", "py-service"),
    ],
    dependencyGraph: {
      nodes: [
        { id: "web", type: "app" },
        { id: "Core" },
        { id: "py-service" },
        { id: "fastapi", type: "external" },
      ],
      edges: [
        { from: "web", to: "Core", type: "depends_on" },
        { from: "py-service", to: "fastapi", type: "dependency" },
      ],
    },
  };
}

function discoveryFor(relativePaths: readonly string[]): EngineeringWorkflowDiscoveryResult {
  return {
    targets: [target("App", "app", "typescript")],
    files: relativePaths.map((relativePath) => file(relativePath, "typescript", "App")),
    dependencyGraph: { nodes: [{ id: "App", type: "app" }], edges: [] },
  };
}

function partialDiscoverer(): EngineeringDiscoverer {
  return {
    id: "partial",
    displayName: "Partial",
    detect: async () => ({ match: true, confidence: 1, reason: "test" }),
    load: async () => undefined,
    listTargets: async () => [
      target("App", "app", "typescript"),
      target("Broken", "library", "typescript"),
    ],
    getTargetFiles: async (targetItem) => {
      if ((typeof targetItem === "string" ? targetItem : targetItem.name) === "Broken") {
        throw new Error("boom");
      }
      return [file("src/index.ts", "typescript", "App")];
    },
    getDependencyGraph: async () => ({ nodes: [{ id: "App", type: "app" }], edges: [] }),
  };
}

function target(name: string, type: string, language: string): EngineeringTarget {
  return {
    name,
    type,
    language,
    path: `/repo/${name}`,
  };
}

function file(relativePath: string, language: string, targetName: string) {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    language,
    targetName,
    isTest: false,
  };
}

class FailingSnapshotStore implements EngineeringWorkflowSnapshotStore {
  readLatest() {
    return {
      snapshot: null,
      diagnostics: [
        {
          code: "baseline_missing",
          severity: "info",
          message: "No previous engineering workflow snapshot found; full rescan required",
        },
      ],
    };
  }

  readSnapshot() {
    return this.readLatest();
  }

  writeSnapshot(_input: EngineeringWorkflowSnapshotWriteInput) {
    return {
      snapshot: null,
      snapshotId: null,
      prunedIds: [],
      diagnostics: [
        {
          code: "snapshot_write_failed",
          severity: "warn",
          message: "forced write failure",
        },
      ],
    };
  }

  listSnapshots() {
    return [];
  }

  clearProject() {
    return [];
  }
}
