import { describe, expect, it } from "vitest";
import { buildEngineeringWorkflowSnapshot } from "../cache/EngineeringWorkflowSnapshotStore.js";
import { computeEngineeringWorkflowFileDiff } from "../cache/FileDiffPlanner.js";
import { planEngineeringProjectIntelligenceIncremental } from "./ProjectIntelligenceIncrementalPlanner.js";

const dimensions = [
  "project-profile",
  "code-standard",
  "architecture",
  "module-export-scan",
  "code-pattern",
  "best-practice",
  "event-and-data-flow",
];

describe("EngineeringProjectIntelligenceIncrementalPlanner", () => {
  it("falls back to full rescan when baseline is missing", () => {
    const plan = planEngineeringProjectIntelligenceIncremental({
      projectRoot: "/repo",
      snapshot: null,
      diff: null,
      allDimensions: dimensions,
    });

    expect(plan.mode).toBe("full-rescan");
    expect(plan.affectedDimensions).toEqual(dimensions);
  });

  it("skips when the diff has no meaningful file changes", () => {
    const snapshot = buildEngineeringWorkflowSnapshot({
      id: "baseline",
      projectRoot: "/repo",
      allFiles: [{ relativePath: "src/a.ts", content: "same" }],
    });
    const diff = computeEngineeringWorkflowFileDiff({
      projectRoot: "/repo",
      snapshot,
      currentFiles: [
        { relativePath: "src/a.ts", content: "same" },
        { relativePath: ".cursor/rules/alembic.mdc", content: "generated" },
      ],
    });

    const plan = planEngineeringProjectIntelligenceIncremental({
      projectRoot: "/repo",
      snapshot,
      diff,
      allDimensions: dimensions,
    });

    expect(plan.mode).toBe("skip");
    expect(plan.affectedDimensions).toEqual([]);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "generated_artifact_skipped",
    );
  });

  it("plans panorama-only work for pure moves", () => {
    const snapshot = buildEngineeringWorkflowSnapshot({
      id: "baseline",
      projectRoot: "/repo",
      allFiles: [{ relativePath: "src/old.ts", content: "same" }],
    });
    const diff = computeEngineeringWorkflowFileDiff({
      projectRoot: "/repo",
      snapshot,
      currentFiles: [{ relativePath: "src/new.ts", content: "same" }],
    });

    const plan = planEngineeringProjectIntelligenceIncremental({
      projectRoot: "/repo",
      snapshot,
      diff,
      allDimensions: dimensions,
    });

    expect(plan.mode).toBe("panorama-only");
    expect(plan.affectedFiles).toEqual(["src/new.ts", "src/old.ts"]);
    expect(plan.affectedModules).toEqual(["src"]);
  });

  it("targets dimensions from referenced files and file type inference", () => {
    const snapshot = buildEngineeringWorkflowSnapshot({
      id: "baseline",
      projectRoot: "/repo",
      allFiles: [
        { relativePath: "packages/app/src/service.ts", content: "old" },
        { relativePath: "packages/core/src/index.ts", content: "same" },
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
    });
    const diff = computeEngineeringWorkflowFileDiff({
      projectRoot: "/repo",
      snapshot,
      currentFiles: [
        { relativePath: "packages/app/src/service.ts", content: "new" },
        { relativePath: "packages/core/src/index.ts", content: "same" },
        { relativePath: "packages/core/src/a.ts", content: "same" },
        { relativePath: "packages/core/src/b.ts", content: "same" },
        { relativePath: "packages/core/src/c.ts", content: "same" },
        { relativePath: "packages/core/src/d.ts", content: "same" },
        { relativePath: "packages/app/src/new.ts", content: "new file" },
      ],
    });

    const plan = planEngineeringProjectIntelligenceIncremental({
      projectRoot: "/repo",
      snapshot,
      diff,
      allDimensions: dimensions,
    });

    expect(plan.mode).toBe("targeted-rescan");
    expect(plan.affectedModules).toEqual(["packages/app"]);
    expect(plan.affectedDimensions).toEqual([
      "project-profile",
      "code-standard",
      "architecture",
      "module-export-scan",
      "code-pattern",
      "best-practice",
      "event-and-data-flow",
    ]);
  });

  it("forces full rescan on project root mismatch", () => {
    const snapshot = buildEngineeringWorkflowSnapshot({
      id: "baseline",
      projectRoot: "/old-repo",
      allFiles: [{ relativePath: "src/a.ts", content: "same" }],
    });
    const diff = computeEngineeringWorkflowFileDiff({
      projectRoot: "/new-repo",
      snapshot,
      currentFiles: [{ relativePath: "src/a.ts", content: "same" }],
    });

    const plan = planEngineeringProjectIntelligenceIncremental({
      projectRoot: "/new-repo",
      snapshot,
      diff,
      allDimensions: dimensions,
    });

    expect(plan.mode).toBe("full-rescan");
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_root_mismatch",
    );
  });
});
