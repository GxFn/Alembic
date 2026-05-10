import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryContextIndex } from "../data/index.js";
import { createRecipe, createRecipeKnowledgePayload } from "../knowledge/index.js";
import { CompileArtifactWriter } from "./CompileArtifactWriter.js";
import { ContentMiningRunner } from "./ContentMiningRunner.js";
import { IncrementalEvidenceCompiler } from "./IncrementalEvidenceCompiler.js";
import { SourceRefMaterializer } from "./SourceRefMaterializer.js";

describe("content mining compile path", () => {
  it("compiles diff evidence and writes source refs, recipes, and edges", async () => {
    const contextIndex = new InMemoryContextIndex();
    const runner = new ContentMiningRunner(new CompileArtifactWriter(contextIndex), {
      evidenceCompiler: new IncrementalEvidenceCompiler({
        materializer: new SourceRefMaterializer(),
      }),
    });
    const recipes = [
      recipe("recipe-api-client", "API Client", ["src/api-client.ts"]),
      recipe("recipe-api-logging", "API Logging", ["src/api-client.ts"]),
    ];

    const artifacts = await runner.compileAndWrite({
      evidenceRequest: {
        projectRoot: path.join(os.tmpdir(), "alembic-content-mining"),
        origin: "diff",
        diffTextByPath: {
          "src/api-client.ts": [
            "@@ -1,2 +1,3 @@",
            "-export function getUser() {}",
            "+export async function fetchUser() { return fetch('/api/user'); }",
          ].join("\n"),
        },
        notes: ["API client changed"],
        id: "evidence-api-client",
      },
      recipes,
      generatedAt: 1,
    });

    expect(artifacts.evidencePackage.changedFiles).toEqual(["src/api-client.ts"]);
    expect(artifacts.lensActivations.map((lens) => lens.lensId)).toContain("networking-api");
    expect(artifacts.edges).toEqual([
      expect.objectContaining({
        fromRecipeId: "recipe-api-client",
        toRecipeId: "recipe-api-logging",
        relation: "same_context",
      }),
    ]);
    expect(artifacts.compileReport.nextSteps.map((step) => step.code)).toContain(
      "write-context-index",
    );

    await expect(contextIndex.findSourceRefsByIds(["src/api-client.ts"])).resolves.toEqual([
      expect.objectContaining({ id: "src/api-client.ts", status: "active" }),
    ]);
    await expect(contextIndex.findRecipesByIds(["recipe-api-client"])).resolves.toEqual([
      expect.objectContaining({ id: "recipe-api-client" }),
    ]);
    await expect(contextIndex.findRecipeEdges(["recipe-api-client"])).resolves.toHaveLength(1);
  });
});

function recipe(id: string, title: string, sourceRefIds: readonly string[]) {
  return createRecipe({
    id,
    title,
    kind: "pattern",
    status: "candidate",
    summary: `Use ${title}.`,
    sourceRefIds,
    confidence: 0.8,
    knowledge: createRecipeKnowledgePayload({ language: "typescript" }),
  });
}
