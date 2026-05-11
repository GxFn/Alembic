import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MainlineEmbeddingPort } from "../ai/index.js";
import { InMemoryMainlineJobLedger } from "../data/index.js";
import { createRecipe, createRecipeKnowledgePayload } from "../knowledge/index.js";
import { MainlineCompileSession } from "./index.js";

describe("mainline compile session", () => {
  it("runs cold-start then incremental compile with persisted baselines", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-compile-root-"));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-compile-data-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "api.ts"),
        "export function fetchUser() { return null; }\n",
      );
      const recipe = createRecipe({
        id: "recipe-api-client",
        title: "API Client",
        status: "active",
        sourceRefIds: ["src/api.ts"],
        knowledge: createRecipeKnowledgePayload({
          coreCode: "fetchUser();",
          content: {
            pattern: "Use fetchUser for user API loading.",
            steps: [{ code: "return fetchUser();" }],
          },
          sourceFile: "src/api.ts",
        }),
      });
      const jobLedger = new InMemoryMainlineJobLedger();
      const session = new MainlineCompileSession({ jobLedger });

      const coldStart = await session.run({
        projectRoot: root,
        mode: "cold-start",
        workspace: { dataRoot },
        recipes: [recipe],
        generatedAt: 1,
      });

      expect(coldStart.fingerprintDiff.added).toEqual(["src/api.ts"]);
      expect(coldStart.projectIntelligence.artifact.files.map((file) => file.path)).toEqual([
        "src/api.ts",
      ]);
      expect(coldStart.recipeMarkdown.written).toBe(1);
      expect(coldStart.search.persistedDocuments).toBeGreaterThan(0);

      await fs.writeFile(
        path.join(root, "src", "api.ts"),
        "export function fetchUser() { return fetch('/api/user'); }\n",
      );
      const incremental = await session.run({
        projectRoot: root,
        mode: "incremental",
        workspace: { dataRoot },
        recipes: [recipe],
        generatedAt: 2,
        diffTextByPath: {
          "src/api.ts": [
            "@@ -1 +1 @@",
            "-export function fetchUser() { return null; }",
            "+export function fetchUser() { return fetch('/api/user'); }",
          ].join("\n"),
        },
      });

      expect(incremental.fingerprintDiff.modified).toEqual(["src/api.ts"]);
      expect(incremental.recipeImpact.impacts).toContainEqual(
        expect.objectContaining({
          recipeId: "recipe-api-client",
          reason: "source-modified-pattern",
          suggestedAction: "update",
        }),
      );
      expect(incremental.sourceRefRepair.summary).toEqual({
        movedFileCount: 0,
        removedFileCount: 0,
        repairedSourceRefCount: 0,
        staleSourceRefCount: 0,
        affectedRecipeCount: 0,
      });
      expect(incremental.progress.checkpoints.map((checkpoint) => checkpoint.phase)).toContain(
        "source-ref-repair",
      );
      expect(incremental.cancel.supported).toBe(false);
      expect(incremental.cancel.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
        "pre-run",
        "pre-source-ref-repair",
        "post-source-ref-repair",
        "post-run",
      ]);
      expect(incremental.cancel.warnings[0]).toContain("checkpoint-only");
      expect(incremental.search.restoredDocuments).toBeGreaterThan(0);
      await expect(jobLedger.list({ kind: "mainline-compile-session" })).resolves.toEqual([
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "completed" }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("keeps sparse SearchIndex persistence when embedding fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-compile-root-"));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-compile-data-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "search.ts"),
        "export function search() { return 'sparse'; }\n",
      );
      const result = await new MainlineCompileSession({
        embeddingProvider: failingEmbeddingProvider(),
      }).run({
        projectRoot: root,
        mode: "cold-start",
        workspace: { dataRoot },
        generatedAt: 1,
      });

      expect(result.search.persistedDocuments).toBeGreaterThan(0);
      expect(result.search.embeddingFailures).toBeGreaterThan(0);
      const searchSnapshot = JSON.parse(
        await fs.readFile(path.join(dataRoot, ".asd/context/search-index.json"), "utf8"),
      ) as { readonly documents: readonly { readonly id: string }[] };
      expect(searchSnapshot.documents).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "file:src/search.ts" })]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });
});

function failingEmbeddingProvider(): MainlineEmbeddingPort {
  return {
    status: () => ({ provider: "test", model: "failing", ready: true, mock: false }),
    embedText: async () => {
      throw new Error("embedding unavailable");
    },
    embedBatch: async () => {
      throw new Error("embedding unavailable");
    },
  };
}
