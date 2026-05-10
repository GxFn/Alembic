import { describe, expect, it } from "vitest";
import {
  InMemoryMainlineProjectIntelligenceArtifactStore,
  MainlineProjectIntelligenceMaterializer,
  mergeMainlineProjectIntelligenceArtifact,
} from "../compile/index.js";
import { InMemoryContextIndex } from "../data/index.js";
import { InMemoryMainlineSearchIndex } from "../search/index.js";
import { MainlineProjectIntelligenceBuilder, MainlineProjectIntelligenceQueries } from "./index.js";

describe("mainline project intelligence read model", () => {
  it("builds graph facts and answers call/dependency queries", async () => {
    const artifact = await sampleArtifact();
    const queries = new MainlineProjectIntelligenceQueries(artifact);

    expect(artifact.files.map((file) => file.path)).toEqual(["src/app.ts", "src/util.ts"]);
    expect(artifact.projectGraph.edges).toContainEqual(
      expect.objectContaining({
        from: "file:src/app.ts",
        to: "file:src/util.ts",
        kind: "imports",
        specifier: "./util",
      }),
    );
    expect(queries.callees("src/app.ts::App").map((relation) => relation.symbol.fqn)).toEqual([
      "src/app.ts::render",
    ]);
    expect(queries.callers("src/app.ts::render").map((relation) => relation.symbol.fqn)).toEqual([
      "src/app.ts::App",
    ]);
    expect(queries.fileDependencyAdjacency("src/app.ts")[0]?.dependencies).toEqual([
      expect.objectContaining({ file: "src/util.ts", kind: "imports", specifier: "./util" }),
    ]);
  });

  it("stores cloned artifacts, merges affected files, and materializes runtime indexes", async () => {
    const previousArtifact = await sampleArtifact();
    const patchArtifact = await new MainlineProjectIntelligenceBuilder().build({
      projectRoot: "/project",
      knownFiles: ["src/util.ts"],
      files: [
        {
          path: "src/util.ts",
          content: "export function helperV2() { return true; }\n",
          languageId: "typescript",
        },
      ],
      generatedAt: 2,
    });

    const merged = mergeMainlineProjectIntelligenceArtifact({
      previousArtifact,
      patchArtifact,
      incrementalPlan: { affectedFiles: ["src/util.ts"] },
      generatedAt: 3,
    });
    const artifactStore = new InMemoryMainlineProjectIntelligenceArtifactStore();
    await artifactStore.save(merged);
    const stored = await artifactStore.load();
    const contextIndex = new InMemoryContextIndex();
    const searchIndex = new InMemoryMainlineSearchIndex();
    const materialized = await new MainlineProjectIntelligenceMaterializer().materialize(
      stored ?? merged,
      { contextIndex, searchIndex },
      { searchDocumentIdsToRemove: ["symbol:src/util.ts::helper"] },
    );

    expect(stored).not.toBe(merged);
    expect(stored?.generatedAt).toBe(3);
    expect(merged.symbols.map((symbol) => symbol.fqn)).toEqual([
      "src/app.ts::App",
      "src/app.ts::render",
      "src/util.ts::helperV2",
    ]);
    expect(materialized.sourceRefs.map((sourceRef) => sourceRef.id)).toEqual([
      "src/app.ts",
      "src/util.ts",
      "symbol:src/app.ts::App",
      "symbol:src/app.ts::render",
      "symbol:src/util.ts::helperV2",
    ]);
    expect(await contextIndex.findSourceRefsByIds(["symbol:src/util.ts::helperV2"])).toHaveLength(
      1,
    );
    expect(searchIndex.search({ text: "helperV2", kinds: ["symbol"] })[0]?.document.id).toBe(
      "symbol:src/util.ts::helperV2",
    );
  });
});

async function sampleArtifact() {
  return new MainlineProjectIntelligenceBuilder().build({
    projectRoot: "/project",
    knownFiles: ["src/app.ts", "src/util.ts"],
    files: [
      {
        path: "src/app.ts",
        content: [
          'import { helper } from "./util";',
          "export function App() {",
          "  return render();",
          "}",
          "function render() {",
          "  return helper();",
          "}",
          "",
        ].join("\n"),
        languageId: "typescript",
      },
      {
        path: "src/util.ts",
        content: "export function helper() { return true; }\n",
        languageId: "typescript",
      },
    ],
    generatedAt: 1,
  });
}
