import { describe, expect, it } from "vitest";
import { type MainlineBatchEmbedder, MainlineHybridSearch } from "./HybridSearch.js";
import { InMemoryMainlineSearchIndex } from "./SearchIndex.js";
import { projectMainlineSearchDocuments } from "./SearchProjection.js";
import { InMemoryMainlineVectorStore } from "./VectorStore.js";

describe("mainline search index", () => {
  it("ranks exact triggers and paths from compiled documents", () => {
    const index = new InMemoryMainlineSearchIndex();
    index.upsert([
      {
        id: "recipe:ghost-init",
        kind: "recipe",
        title: "Ghost workspace init",
        body: "Initialize Alembic without project-local artifacts.",
        path: "lib/codex/workspace.ts",
        tags: ["codex", "ghost"],
        metadata: { trigger: "ghost mode init" },
      },
      {
        id: "recipe:daemon",
        kind: "recipe",
        title: "Daemon job lifecycle",
        body: "Durable job state for bootstrap and rescan.",
        path: "lib/daemon/JobStore.ts",
      },
    ]);

    expect(index.search({ text: "ghost mode init", limit: 1 })[0]?.document.id).toBe(
      "recipe:ghost-init",
    );
    expect(index.search({ paths: ["lib/daemon/JobStore.ts"], limit: 1 })[0]?.document.id).toBe(
      "recipe:daemon",
    );
  });

  it("projects search documents from compiled context artifacts without scanning markdown", () => {
    const documents = projectMainlineSearchDocuments({
      snapshot: {
        recipes: [
          {
            id: "recipe-1",
            kind: "workflow",
            status: "active",
            sourceRefIds: ["src/runtime.ts"],
            title: "Runtime prime",
            summary: "Load ContextIndex before Codex work.",
            tags: ["runtime", "prime"],
            confidence: 0.8,
          },
        ],
        edges: [],
        sourceRefs: [
          {
            id: "src/runtime.ts",
            location: { path: "src/runtime.ts" },
          },
        ],
      },
    });

    expect(documents.map((document) => document.id)).toEqual([
      "recipe:recipe-1",
      "source-ref:src/runtime.ts",
    ]);
  });

  it("embeds documents into the vector store and fuses vector-only retrieval", async () => {
    const index = new InMemoryMainlineSearchIndex();
    const vectorStore = new InMemoryMainlineVectorStore();
    const embedder: MainlineBatchEmbedder = {
      embedBatch: async (inputs) =>
        inputs.map((input) => ({
          id: input.id,
          vector: input.text.includes("daemon") ? [1, 0] : [0, 1],
          metadata: input.metadata,
        })),
    };
    const documents = [
      {
        id: "recipe:daemon",
        kind: "recipe" as const,
        title: "Daemon lifecycle",
        body: "daemon job state",
      },
      {
        id: "recipe:guard",
        kind: "recipe" as const,
        title: "Guard rules",
        body: "runtime checks",
      },
    ];
    index.upsert(documents);
    const hybrid = new MainlineHybridSearch({ searchIndex: index, vectorStore, embedder });

    await expect(hybrid.embedDocuments(documents)).resolves.toMatchObject({
      vectors: [{ id: "recipe:daemon" }, { id: "recipe:guard" }],
      failures: [],
    });
    await expect(vectorStore.snapshot()).resolves.toHaveLength(2);

    const hits = await hybrid.search({ limit: 1 }, { queryVector: [1, 0] });
    expect(hits[0]).toMatchObject({
      document: { id: "recipe:daemon" },
      sources: ["vector"],
    });
  });
});
