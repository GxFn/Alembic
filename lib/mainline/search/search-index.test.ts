import { describe, expect, it } from "vitest";
import { InMemoryMainlineSearchIndex } from "./SearchIndex.js";
import { projectMainlineSearchDocuments } from "./SearchProjection.js";

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
            sourceRefIds: ["src/runtime.ts"],
            title: "Runtime prime",
            summary: "Load ContextIndex before Codex work.",
            tags: ["runtime", "prime"],
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
});
