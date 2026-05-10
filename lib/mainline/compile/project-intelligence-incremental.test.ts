import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryContextIndex } from "../data/index.js";
import { MainlineProjectIntelligenceBuilder } from "../graph/index.js";
import { InMemoryMainlineSearchIndex } from "../search/index.js";
import {
  InMemoryMainlineProjectIntelligenceArtifactStore,
  MainlineProjectIntelligenceIncrementalPlanner,
  MainlineProjectIntelligenceRunner,
} from "./index.js";

describe("project intelligence incremental compile path", () => {
  it("plans changed, deleted, and dependent files from the previous artifact", async () => {
    const artifact = await new MainlineProjectIntelligenceBuilder().build({
      projectRoot: "/project",
      knownFiles: ["src/app.ts", "src/util.ts", "src/old.ts"],
      files: [
        {
          path: "src/app.ts",
          content: 'import { helper } from "./util";\nexport function App() { return helper(); }\n',
          languageId: "typescript",
        },
        {
          path: "src/util.ts",
          content: "export function helper() { return true; }\n",
          languageId: "typescript",
        },
        {
          path: "src/old.ts",
          content: "export const old = true;\n",
          languageId: "typescript",
        },
      ],
      generatedAt: 1,
    });

    const plan = new MainlineProjectIntelligenceIncrementalPlanner().plan({
      artifact,
      fingerprintDiff: {
        added: [],
        modified: ["src/util.ts"],
        deleted: ["src/old.ts"],
        unchanged: ["src/app.ts"],
        changeRatio: 0.2,
      },
    });

    expect(plan.changedFiles).toEqual(["src/util.ts"]);
    expect(plan.deletedFiles).toEqual(["src/old.ts"]);
    expect(plan.dependentFiles).toEqual(["src/app.ts"]);
    expect(plan.filesToParse).toEqual(["src/app.ts", "src/util.ts"]);
    expect(plan.sourceRefIdsToStale).toContain("symbol:src/old.ts::old");
    expect(plan.searchDocumentIdsToRefresh).toContain("symbol:src/util.ts::helper");
  });

  it("runs incremental rebuilds and materializes stale symbol cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-pi-runner-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "app.ts"),
        'import { helper } from "./util";\nexport function App() { return helper(); }\n',
      );
      await fs.writeFile(
        path.join(root, "src", "util.ts"),
        "export function helper() { return true; }\n",
      );

      const artifactStore = new InMemoryMainlineProjectIntelligenceArtifactStore();
      const contextIndex = new InMemoryContextIndex();
      const searchIndex = new InMemoryMainlineSearchIndex();
      const runner = new MainlineProjectIntelligenceRunner({
        artifactStore,
        contextIndex,
        searchIndex,
      });

      await runner.run({
        projectRoot: root,
        generatedAt: 1,
      });
      await fs.writeFile(
        path.join(root, "src", "util.ts"),
        "export function helperV2() { return true; }\n",
      );

      const result = await runner.run({
        projectRoot: root,
        generatedAt: 2,
        incremental: {
          changedFiles: ["src/util.ts"],
        },
      });

      expect(result.incrementalPlan?.dependentFiles).toEqual(["src/app.ts"]);
      expect(result.artifact.symbols.map((symbol) => symbol.fqn)).toEqual([
        "src/app.ts::App",
        "src/util.ts::helperV2",
      ]);
      expect(result.materialized?.staleSourceRefs.map((sourceRef) => sourceRef.id)).toContain(
        "symbol:src/util.ts::helper",
      );
      expect(result.materialized?.removedSearchDocumentIds).toContain("symbol:src/util.ts::helper");
      expect(searchIndex.search({ text: "helperV2", kinds: ["symbol"] })[0]?.document.id).toBe(
        "symbol:src/util.ts::helperV2",
      );
      await expect(
        contextIndex.findSourceRefsByIds(["symbol:src/util.ts::helper"]),
      ).resolves.toEqual([expect.objectContaining({ status: "stale" })]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
