import { describe, expect, it } from "vitest";
import {
  buildProjectSnapshot,
  projectSnapshotFromEngineeringWorkflowResult,
  toResponseData,
  toSessionCache,
} from "../../snapshot/index.js";
import type { EngineeringWorkflowDimensionFileRef } from "../optional/types.js";
import type { EngineeringWorkflowResult } from "../types.js";

describe("Engineering project snapshot migration", () => {
  it("normalizes loose engineering inputs into a frozen ProjectSnapshot", () => {
    const snapshot = buildProjectSnapshot({
      projectRoot: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      allFiles: [
        {
          path: "/repo/src/app.ts",
          content: "one\ntwo",
          language: "ts",
          targetName: "App",
        },
        "README.md",
      ],
      allTargets: [
        {
          name: "App",
          type: "library",
          framework: "react",
          metadata: {
            isLocalPackage: true,
            packageName: "@repo/app",
            inferredRole: "ui",
          },
        },
      ],
      discoverer: { id: "fixture", displayName: "Fixture Discoverer" },
      langStats: { ts: 2, md: 1 },
      primaryLang: null,
      enhancementPackInfo: "ignored",
      localPackageModules: "ignored",
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.version).toBe("engineering-project-snapshot/v1");
    expect(snapshot.allFiles[0]).toMatchObject({
      name: "app.ts",
      path: "/repo/src/app.ts",
      relativePath: "src/app.ts",
      language: "ts",
      targetName: "App",
      totalLines: 2,
    });
    expect(snapshot.language).toMatchObject({
      primaryLang: "ts",
      stats: { ts: 2, md: 1 },
      isMultiLang: true,
    });
    expect(snapshot.allTargets[0]).toMatchObject({
      name: "App",
      framework: "react",
      fileCount: 1,
      packageName: "@repo/app",
      inferredRole: "ui",
    });
    expect(snapshot.localPackageModules).toEqual([
      {
        name: "App",
        packageName: "@repo/app",
        fileCount: 1,
        inferredRole: "ui",
        keyFiles: ["src/app.ts"],
      },
    ]);
    expect(snapshot.enhancementPackInfo).toEqual([]);
  });

  it("projects EngineeringWorkflowResult into ProjectSnapshot without runtime state", () => {
    const result = workflowResultFixture();
    const snapshot = projectSnapshotFromEngineeringWorkflowResult(result, {
      fileContents: { "src/app.ts": "render()" },
      sourceTag: "unit-test",
    });

    expect(snapshot.sourceTag).toBe("unit-test");
    expect(snapshot.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(snapshot.projectRoot).toBe("/repo");
    expect(snapshot.discoverer).toEqual({ id: "fixture", displayName: "Fixture Discoverer" });
    expect(snapshot.allFiles[0]?.content).toBe("render()");
    expect(snapshot.callGraph).toHaveLength(1);
    expect(snapshot.guardAudit?.summary.fileCount).toBe(1);
    expect(snapshot.activeDimensions.map((dimension) => dimension.id)).toEqual(["ui"]);
    expect(snapshot.enhancementPackInfo.map((pack) => pack.id)).toEqual(["react"]);
    expect(snapshot.dimensionFileRefs.map((ref) => ref.filePath)).toEqual(["src/app.ts"]);
    expect(snapshot.snapshotRun).toMatchObject({ snapshotId: "snap_1", saved: true });
    expect(snapshot.snapshotId).toBe("snap_1");
  });

  it("builds response data and a typed session cache from ProjectSnapshot", () => {
    const snapshot = projectSnapshotFromEngineeringWorkflowResult(workflowResultFixture(), {
      fileContents: { "src/app.ts": "render()" },
    });

    const response = toResponseData(snapshot);
    const sessionCache = toSessionCache(snapshot);

    expect(response).toMatchObject({
      filesScanned: 1,
      primaryLanguage: "ts",
      guardSummary: {
        files: 1,
        totalFindings: 0,
      },
      dependencyGraph: {
        nodes: [{ id: "App", label: "App" }],
      },
      warnings: ["Fixture warning"],
    });
    expect(response.enhancementPacks).toMatchObject({
      matched: [{ id: "react", displayName: "React" }],
      patterns: 0,
      guardRules: 0,
    });
    expect(sessionCache).toMatchObject({
      fileContents: { "src/app.ts": "render()" },
      primaryLang: "ts",
      snapshotId: "snap_1",
      generatedArtifactBlacklist: ["AGENTS.md"],
    });
    expect(sessionCache.allFiles[0]?.relativePath).toBe("src/app.ts");
    expect(sessionCache.activeDimensions.map((dimension) => dimension.id)).toEqual(["ui"]);
    expect(sessionCache.depGraphData?.nodes).toEqual(["App"]);
  });
});

function workflowResultFixture(): EngineeringWorkflowResult {
  const dimensionRef: EngineeringWorkflowDimensionFileRef = {
    dimensionId: "ui",
    filePath: "src/app.ts",
    source: "dimension-module",
    reason: "UI module coverage",
    confidence: 0.9,
  };

  return {
    status: "success",
    artifact: {
      projectRoot: "/repo",
      targets: [
        {
          name: "App",
          path: "/repo",
          type: "app",
          language: "ts",
          framework: "react",
        },
      ],
      files: [
        {
          name: "app.ts",
          path: "/repo/src/app.ts",
          relativePath: "src/app.ts",
          language: "ts",
          targetName: "App",
        },
      ],
      dependencyGraph: {
        nodes: ["App"],
        edges: [],
      },
      codeGraph: {
        classes: [],
        protocols: [],
        categories: [],
        files: [],
        callGraphEdges: [],
        dataFlowEdges: [],
        overview: {
          totalFiles: 1,
          totalClasses: 0,
          totalProtocols: 0,
          totalCategories: 0,
          totalMethods: 0,
          topLevelModules: ["App"],
          entryPoints: [],
          classesPerModule: {},
        },
      },
      callGraph: [
        {
          caller: "App.render",
          callee: "render",
          callType: "direct",
          resolveMethod: "symbol",
          line: 1,
          filePath: "src/app.ts",
          isAwait: false,
          argCount: 0,
          sourceFilePath: "src/app.ts",
          targetFilePath: "src/render.ts",
        },
      ],
      dataFlow: [],
      entityGraph: {
        entities: [],
        edges: [],
        topology: {
          nodeCount: 0,
          edgeCount: 0,
          roots: [],
          leaves: [],
          isolated: [],
          components: [],
          cycles: [],
        },
      },
      panoramaSnapshot: null,
      optionalStage: {
        status: "success",
        result: {
          enhancement: {
            packs: [
              {
                id: "react",
                displayName: "React",
                matched: true,
                confidence: 0.95,
                signals: [],
              },
            ],
            signals: [],
            patterns: [],
            guardRules: [],
            dimensions: [
              {
                id: "ui",
                label: "UI",
                knowledgeTypes: [],
              },
            ],
            diagnostics: [],
          },
          guard: {
            rules: [],
            findings: [],
            diagnostics: [],
            summary: {
              fileCount: 1,
              ruleCount: 0,
              callbackCount: 0,
              totalFindings: 0,
              errors: 0,
              warnings: 0,
              infos: 0,
            },
          },
          enhancementReaudit: null,
          dimensions: {
            activeDimensions: [
              {
                id: "ui",
                label: "UI",
                knowledgeTypes: [],
              },
            ],
            gates: [],
            fileRefs: [dimensionRef],
            diagnostics: [],
          },
          diagnostics: [],
        },
        enhancementSignals: [],
        guardFindings: [],
        dimensionGates: [],
        dimensionFileRefs: [dimensionRef],
        diagnostics: [],
      },
      dimensionFileRefs: [dimensionRef],
      generatedArtifactBlacklist: ["AGENTS.md"],
      truncated: false,
      incrementalPlan: null,
      snapshotId: "snap_1",
    },
    phases: [
      {
        name: "discover",
        status: "success",
        timing: {
          startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
          endedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
          durationMs: 1000,
        },
        diagnostics: [],
        summary: {
          discovererId: "fixture",
          discovererName: "Fixture Discoverer",
          targets: 1,
          files: 1,
        },
      },
    ],
    diagnostics: [
      {
        phase: "cache",
        severity: "warning",
        message: "Fixture warning",
      },
    ],
    capabilities: {
      injectedDiscovery: true,
      injectedAstSummaries: false,
      injectedFileContents: true,
      injectedImportFacts: false,
      discovery: true,
      factCollection: true,
      codeGraph: true,
      callGraph: true,
      dataFlow: true,
      entityGraph: true,
      panorama: false,
      optionalStage: true,
      dimensionFileRefs: true,
      cache: true,
      incrementalStore: true,
    },
    truncated: false,
    incrementalPlan: null,
    snapshot: {
      baselineSnapshotId: null,
      snapshotId: "snap_1",
      saved: true,
      prunedIds: [],
    },
  };
}
