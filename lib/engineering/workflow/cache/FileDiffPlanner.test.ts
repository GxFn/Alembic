import { describe, expect, it } from "vitest";
import {
  buildEngineeringWorkflowSnapshot,
  InMemoryEngineeringWorkflowSnapshotStore,
} from "./EngineeringWorkflowSnapshotStore.js";
import {
  computeEngineeringWorkflowFileDiff,
  EngineeringWorkflowFileDiffPlanner,
} from "./FileDiffPlanner.js";

describe("EngineeringWorkflowFileDiffPlanner", () => {
  it("detects added, modified, deleted, moved, unchanged, and generated skipped files", () => {
    const snapshot = buildEngineeringWorkflowSnapshot({
      id: "baseline",
      projectRoot: "/repo",
      allFiles: [
        { relativePath: "src/a.ts", content: "same" },
        { relativePath: "src/b.ts", content: "old" },
        { relativePath: "src/delete.ts", content: "remove me" },
        { relativePath: "src/move-old.ts", content: "move me" },
      ],
    });

    const diff = computeEngineeringWorkflowFileDiff({
      projectRoot: "/repo",
      snapshot,
      currentFiles: [
        { relativePath: "src/a.ts", content: "same" },
        { relativePath: "src/b.ts", content: "new" },
        { relativePath: "src/c.ts", content: "added" },
        { relativePath: "src/move-new.ts", content: "move me" },
        { relativePath: "AGENTS.md", content: "generated" },
      ],
    });

    expect(diff.added).toEqual(["src/c.ts"]);
    expect(diff.modified).toEqual(["src/b.ts"]);
    expect(diff.deleted).toEqual(["src/delete.ts"]);
    expect(diff.moved).toEqual([
      {
        from: "src/move-old.ts",
        to: "src/move-new.ts",
        hash: expect.any(String) as string,
      },
    ]);
    expect(diff.unchanged).toEqual(["src/a.ts"]);
    expect(diff.generatedSkipped).toEqual(["AGENTS.md"]);
    expect(diff.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "generated_artifact_skipped",
    );
  });

  it("reconciles legacy suffix paths against current scan paths", () => {
    const snapshot = buildEngineeringWorkflowSnapshot({
      id: "baseline",
      projectRoot: "/repo",
      allFiles: [{ relativePath: "a.ts", content: "same" }],
    });

    const diff = computeEngineeringWorkflowFileDiff({
      projectRoot: "/repo",
      snapshot,
      currentFiles: [{ relativePath: "src/a.ts", content: "same" }],
    });

    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual(["src/a.ts"]);
    expect(diff.diagnostics.map((diagnostic) => diagnostic.code)).toContain("path_reconciled");
  });

  it("emits project root mismatch diagnostics without throwing", () => {
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

    expect(diff.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_root_mismatch",
    );
  });

  it("reports baseline missing through the store-backed planner", () => {
    const planner = new EngineeringWorkflowFileDiffPlanner(
      new InMemoryEngineeringWorkflowSnapshotStore(),
    );

    const evaluation = planner.evaluate({
      projectRoot: "/repo",
      currentFiles: [{ relativePath: "src/a.ts", content: "same" }],
    });

    expect(evaluation.snapshot).toBeNull();
    expect(evaluation.diff).toBeNull();
    expect(evaluation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "baseline_missing",
    );
  });
});
