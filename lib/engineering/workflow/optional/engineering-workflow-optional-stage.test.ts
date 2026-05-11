import { describe, expect, it } from "vitest";
import type { EngineeringFile } from "../../foundation/EngineeringCoreTypes.js";
import type { EngineeringPanoramaSnapshot } from "../../panorama/EngineeringPanoramaTypes.js";
import { gateOptionalDimensions } from "./DimensionGating.js";
import { preprocessEnhancements } from "./EnhancementPreprocessor.js";
import { runOptionalGuardAudit } from "./GuardAudit.js";
import { runEngineeringWorkflowOptionalStage } from "./OptionalStage.js";

describe("Engineering workflow optional stage", () => {
  it("detects React, Node, FastAPI, and Rust web legacy enhancement packs", () => {
    const result = preprocessEnhancements({
      files: [
        file("apps/web/src/App.tsx", "typescript"),
        file("apps/api/src/server.ts", "typescript"),
        file("services/py/main.py", "python"),
        file("crates/api/src/routes.rs", "rust"),
      ],
      importFacts: [
        { filePath: "apps/web/src/App.tsx", specifier: "react" },
        { filePath: "apps/api/src/server.ts", specifier: "express" },
        { filePath: "services/py/main.py", specifier: "fastapi" },
        { filePath: "crates/api/src/routes.rs", specifier: "axum" },
      ],
    });

    expect(result.packs.map((pack) => pack.id)).toEqual(
      expect.arrayContaining(["react", "node-server", "fastapi", "rust-web"]),
    );
    expect(result.patterns.map((pattern) => pattern.packId)).toEqual(
      expect.arrayContaining(["react", "node-server", "fastapi", "rust-web"]),
    );
    expect(result.guardRules.map((rule) => rule.ruleId)).toEqual(
      expect.arrayContaining([
        "react-no-direct-dom",
        "node-no-sync-io",
        "fastapi-sync-in-async",
        "rust-web-unwrap-in-handler",
      ]),
    );
  });

  it("returns an explicit empty diagnostic when no guard rules are provided", () => {
    const result = runOptionalGuardAudit({
      files: [{ path: "/repo/src/index.ts", relativePath: "src/index.ts", content: "export {}" }],
    });

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "optional.guard.empty",
        severity: "info",
      }),
    );
  });

  it("gates dimensions and resolves file refs while reusing the generated artifact blacklist", () => {
    const result = gateOptionalDimensions({
      snapshot: panoramaSnapshot(),
      generatedArtifactBlacklist: ["AGENTS.md"],
    });

    expect(result.activeDimensions.map((dimension) => dimension.id)).toContain("architecture");
    expect(result.fileRefs).toContainEqual(
      expect.objectContaining({
        dimensionId: "architecture",
        filePath: "src/app.ts",
      }),
    );
    expect(result.fileRefs.map((ref) => ref.filePath)).not.toContain("AGENTS.md");
  });

  it("runs pre-audit then enhancement re-audit with matched pack rules", () => {
    const result = runEngineeringWorkflowOptionalStage({
      files: [file("src/App.tsx", "typescript")],
      fileContents: {
        "src/App.tsx":
          "import React from 'react';\nexport function App(){ document.querySelector('#x'); }",
      },
      importFacts: [{ filePath: "src/App.tsx", specifier: "react" }],
    });

    expect(result.guard.diagnostics).toContainEqual(
      expect.objectContaining({ code: "optional.guard.empty" }),
    );
    expect(result.enhancement.packs.map((pack) => pack.id)).toContain("react");
    expect(result.enhancementReaudit?.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "react-no-direct-dom",
        filePath: "src/App.tsx",
      }),
    );
  });
});

function file(relativePath: string, language: string): EngineeringFile {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    language,
    targetName: "app",
    isTest: false,
  };
}

function panoramaSnapshot(): EngineeringPanoramaSnapshot {
  return {
    projectRoot: "/repo",
    generatedAt: null,
    computedAt: 1,
    overview: {
      projectRoot: "/repo",
      moduleCount: 1,
      localModuleCount: 1,
      hostModuleCount: 0,
      fallbackModuleCount: 0,
      localDependencyCount: 0,
      externalDependencyCount: 0,
      cycleCount: 0,
      layerCount: 0,
      totalFileCount: 2,
      sourceFileCount: 1,
      testFileCount: 0,
      docFileCount: 1,
      coverage: {
        source: "pure-analysis",
        coveredModuleCount: 1,
        totalModuleCount: 1,
        ratio: 1,
      },
      health: {
        status: "watch",
        reason: "architecture refs need follow-up",
        score: 80,
        gaps: [],
      },
      hotspots: [],
    },
    modules: [
      {
        name: "app",
        kind: "local",
        role: "api",
        inferredRole: "api",
        roleConfidence: 0.9,
        roleResolution: "clear",
        roleSignals: [],
        uncertainSignals: [],
        fallbackSignals: [],
        discoverySignals: [],
        layer: null,
        files: ["src/app.ts", "AGENTS.md"],
        fileCount: 2,
        sourceFileCount: 1,
        testFileCount: 0,
        docFileCount: 1,
        symbolCount: 1,
        languages: ["typescript"],
        fileGroups: {
          source: ["src/app.ts"],
          test: [],
          doc: ["AGENTS.md"],
          config: [],
          byDirectory: [],
        },
        neighbors: {
          dependencies: [],
          dependents: [],
          externalDependencies: [],
        },
        incoming: [],
        outgoing: [],
        externalDeps: [],
        fanIn: 0,
        fanOut: 0,
        weightedFanIn: 0,
        weightedFanOut: 0,
        summary: "app",
      },
    ],
    relationships: {
      moduleEdges: [],
      couplingEdges: [],
      layerViolations: [],
    },
    layers: [],
    cycles: [],
    externalDeps: [],
    techStack: {
      categories: [],
      hotspots: [],
      totalExternalDeps: 0,
      totalFacts: 0,
      primaryLanguages: ["typescript"],
    },
    dimensions: {
      dimensions: [
        {
          id: "architecture",
          name: "Architecture",
          description: "Architecture coverage",
          score: 40,
          status: "weak",
          level: "assess",
          recipeCount: 0,
          affectedModules: ["app"],
          topRecipes: [],
        },
      ],
      overallScore: 40,
      moduleCoverage: {
        totalModules: 1,
        coveredModules: 0,
        weakModules: ["app"],
        ratio: 0,
      },
      languageCoverage: {
        languages: [{ name: "typescript", fileCount: 1 }],
        primaryLanguages: ["typescript"],
        mixedLanguage: false,
      },
      architectureCoverage: {
        layerCount: 0,
        cycleCount: 0,
        layerViolationCount: 0,
        externalDependencyCount: 0,
        configBasedLayers: false,
      },
      recipeCoverage: {
        source: "placeholder",
        totalRecipes: 0,
        coveredDimensions: 0,
        totalDimensions: 1,
        ratio: 0,
        reason: "test",
      },
      weakAreas: [
        {
          id: "arch-weak",
          dimension: "architecture",
          status: "weak",
          priority: "high",
          reason: "architecture refs need follow-up",
          affectedModules: ["app"],
          suggestedTopics: ["module boundaries"],
        },
      ],
    },
    health: {
      status: "watch",
      reason: "architecture refs need follow-up",
      score: 80,
      gaps: [],
    },
    gaps: [
      {
        id: "gap-1",
        type: "architecture-cycle",
        priority: "high",
        title: "Architecture evidence",
        reason: "src/app.ts participates in boundary analysis",
        module: "app",
        dimension: "architecture",
        evidence: ["src/app.ts:12"],
        scoreImpact: 10,
      },
    ],
    callFlow: {
      edgeCounts: {
        calls: 0,
        dataFlows: 0,
        relationshipCalls: 0,
        relationshipDataFlows: 0,
      },
      topCalled: [],
      entryPoints: [],
      dataProducers: [],
      dataConsumers: [],
      moduleFlows: [],
    },
    roles: [
      {
        module: "app",
        role: "api",
        confidence: 0.9,
        resolution: "clear",
        alternatives: [],
        signals: [],
      },
    ],
    confidence: {
      overall: 0.9,
      moduleDiscovery: 0.9,
      roleRefinement: 0.9,
      relationshipInference: 0.9,
    },
    stale: false,
    cache: {
      enabled: false,
      stale: false,
      reason: "test",
      generatedAt: null,
      computedAt: 1,
      staleAfterMs: null,
    },
  };
}
