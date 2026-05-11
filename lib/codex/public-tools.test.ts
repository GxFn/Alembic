import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainlineProjectIntelligenceBuilder } from "../mainline/graph/index.js";
import {
  createRecipe,
  createSourceRef,
  type RecipeLifecycleRecord,
  RecipeLifecycleStore,
} from "../mainline/knowledge/index.js";
import { projectMainlineSearchDocuments } from "../mainline/search/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { CODEX_TOOLS, handleCodexTool } from "./tools.js";
import { initializeCodexWorkspace } from "./workspace.js";

const tempRoots: string[] = [];

let previousAlembicHome: string | undefined;
let previousHome: string | undefined;
let previousProjectDir: string | undefined;
let previousEmbedProvider: string | undefined;
let previousEmbedModel: string | undefined;
let previousOpenAiKey: string | undefined;

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-public-tools-home-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-public-tools-project-"));
  tempRoots.push(home, projectRoot);

  previousAlembicHome = process.env.ALEMBIC_HOME;
  previousHome = process.env.HOME;
  previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
  previousEmbedProvider = process.env.ALEMBIC_EMBED_PROVIDER;
  previousEmbedModel = process.env.ALEMBIC_EMBED_MODEL;
  previousOpenAiKey = process.env.ALEMBIC_OPENAI_API_KEY;
  process.env.ALEMBIC_HOME = path.join(home, ".asd");
  process.env.HOME = home;
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
});

afterEach(async () => {
  restoreEnv("ALEMBIC_HOME", previousAlembicHome);
  restoreEnv("HOME", previousHome);
  restoreEnv("ALEMBIC_PROJECT_DIR", previousProjectDir);
  restoreEnv("ALEMBIC_EMBED_PROVIDER", previousEmbedProvider);
  restoreEnv("ALEMBIC_EMBED_MODEL", previousEmbedModel);
  restoreEnv("ALEMBIC_OPENAI_API_KEY", previousOpenAiKey);
  vi.unstubAllGlobals();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("Codex public search and structure tools", () => {
  it("registers stable public tool names and schemas", () => {
    const searchTool = CODEX_TOOLS.find((tool) => tool.name === "alembic_search");
    const structureTool = CODEX_TOOLS.find((tool) => tool.name === "alembic_structure");
    const knowledgeTool = CODEX_TOOLS.find((tool) => tool.name === "alembic_knowledge");

    expect(searchTool).toMatchObject({
      name: "alembic_search",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: expect.objectContaining({
          query: expect.objectContaining({ type: "string" }),
          kinds: expect.objectContaining({ type: "array" }),
          projectRoot: expect.objectContaining({ type: "string" }),
        }),
      },
    });
    expect(structureTool).toMatchObject({
      name: "alembic_structure",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: expect.objectContaining({
          operation: expect.objectContaining({
            enum: ["summary", "files", "symbols", "dependencies", "cycles"],
          }),
          projectRoot: expect.objectContaining({ type: "string" }),
        }),
      },
    });
    expect(knowledgeTool).toMatchObject({
      name: "alembic_knowledge",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: expect.objectContaining({
          operation: expect.objectContaining({ enum: ["list", "publish", "reject"] }),
          status: expect.objectContaining({ enum: ["candidate", "active", "rejected", "all"] }),
          projectRoot: expect.objectContaining({ type: "string" }),
        }),
      },
    });
  });

  it("handles alembic_search from SearchIndexSnapshot and ContextIndex", async () => {
    const workspace = initializeCodexWorkspace({
      projectRoot: currentProjectRoot(),
      standard: true,
    });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const recipe = createRecipe({
      id: "codex-public-search",
      title: "Codex public search",
      kind: "workflow",
      status: "active",
      summary: "Search public MCP read models without internal Agent tools.",
      trigger: "codex public search",
      sourceRefIds: ["lib/codex/tools.ts"],
      confidence: 0.9,
    });
    const sourceRef = createSourceRef({
      id: "lib/codex/tools.ts",
      path: "lib/codex/tools.ts",
      status: "active",
      summary: "Codex public tool registry.",
    });
    await persistence.contextIndex.upsertContextArtifacts({
      recipes: [recipe],
      sourceRefs: [sourceRef],
    });
    persistence.searchIndex.upsert(
      projectMainlineSearchDocuments({ recipes: [recipe], sourceRefs: [sourceRef] }),
    );
    await persistence.searchIndex.flush();

    const result = await handleCodexTool("alembic_search", {
      query: "codex public search",
      projectRoot: workspace.projectRoot,
      limit: 5,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      readonly status: string;
      readonly readiness: { readonly contextReady: boolean; readonly searchReady: boolean };
      readonly hitCount: number;
      readonly hits: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
    };
    expect(data.status).toBe("completed");
    expect(data.readiness).toMatchObject({ contextReady: true, searchReady: true });
    expect(data.hitCount).toBeGreaterThan(0);
    expect(data.hits[0]).toMatchObject({ id: "recipe:codex-public-search", kind: "recipe" });
    expect(JSON.stringify(data)).not.toContain("resource.action");
  });

  it("uses vector snapshots for alembic_search when an embedding provider is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ index: 0, embedding: [1, 0] }],
        }),
      ),
    );
    process.env.ALEMBIC_EMBED_PROVIDER = "openai";
    process.env.ALEMBIC_EMBED_MODEL = "text-embedding-3-small";
    process.env.ALEMBIC_OPENAI_API_KEY = "sk-test";
    const workspace = initializeCodexWorkspace({
      projectRoot: currentProjectRoot(),
      standard: true,
    });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const recipe = createRecipe({
      id: "codex-semantic-vector-search",
      title: "Codex semantic vector search",
      kind: "workflow",
      status: "active",
      summary: "Semantic search uses the persisted vector snapshot.",
      trigger: "semantic vector search",
      confidence: 0.9,
    });
    const [document] = projectMainlineSearchDocuments({ recipes: [recipe] });
    if (!document) {
      throw new Error("Expected projected recipe document.");
    }
    persistence.searchIndex.upsert([document]);
    await persistence.searchIndex.flush();
    await persistence.vectorStore.upsert([
      {
        id: document.id,
        vector: [1, 0],
        content: "semantic-only persisted vector hit",
        ...(document.metadata === undefined ? {} : { metadata: document.metadata }),
      },
    ]);

    const result = await handleCodexTool("alembic_search", {
      query: "unrelated query text",
      projectRoot: workspace.projectRoot,
      limit: 5,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      readonly sources: {
        readonly semantic: string;
        readonly vectorDocumentCount: number;
      };
      readonly hits: ReadonlyArray<{
        readonly id: string;
        readonly reasons: readonly string[];
      }>;
    };
    expect(data.sources).toMatchObject({ semantic: "hybrid", vectorDocumentCount: 1 });
    expect(data.hits[0]).toMatchObject({
      id: "recipe:codex-semantic-vector-search",
      reasons: expect.arrayContaining(["vector:cosine", "fusion:rrf"]),
    });
  });

  it("handles alembic_structure from the ProjectIntelligence artifact", async () => {
    const workspace = initializeCodexWorkspace({
      projectRoot: currentProjectRoot(),
      standard: true,
    });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const artifact = await new MainlineProjectIntelligenceBuilder().build({
      projectRoot: workspace.projectRoot,
      generatedAt: 1,
      files: [
        {
          path: "src/app.ts",
          content: 'import { helper } from "./util";\nexport function app() { return helper(); }\n',
          languageId: "typescript",
        },
        {
          path: "src/util.ts",
          content: "export function helper() { return 1; }\n",
          languageId: "typescript",
        },
      ],
    });
    await persistence.artifactStore.save(artifact);

    const result = await handleCodexTool("alembic_structure", {
      operation: "dependencies",
      path: "src/app.ts",
      projectRoot: workspace.projectRoot,
      limit: 10,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      readonly status: string;
      readonly readiness: { readonly projectIntelligenceReady: boolean };
      readonly summary: { readonly fileCount: number; readonly symbolCount: number };
      readonly dependencies?: ReadonlyArray<{
        readonly file: string;
        readonly dependencies: ReadonlyArray<{ readonly file: string; readonly kind: string }>;
      }>;
      readonly sources: { readonly source: string };
    };
    expect(data.status).toBe("completed");
    expect(data.readiness.projectIntelligenceReady).toBe(true);
    expect(data.sources.source).toBe("project-intelligence");
    expect(data.summary).toMatchObject({ fileCount: 2, symbolCount: 2 });
    expect(data.dependencies?.[0]).toMatchObject({
      file: "src/app.ts",
      dependencies: [expect.objectContaining({ file: "src/util.ts", kind: "imports" })],
    });
  });

  it("lists alembic_knowledge records with active as the default status", async () => {
    const workspace = initializeCodexWorkspace({
      projectRoot: currentProjectRoot(),
      standard: true,
    });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const lifecycle = new RecipeLifecycleStore(persistence.writeBoundary);
    await lifecycle.writeCandidate(
      lifecycleRecipe("public-candidate-list", "Candidate records stay outside default list."),
      { now: 10 },
    );
    await lifecycle.writeCandidate(
      lifecycleRecipe("public-active-list", "Active records are listed by default."),
      { now: 11 },
    );
    await lifecycle.publish("public-active-list", { now: 12 });

    const activeResult = await handleCodexTool("alembic_knowledge", {
      operation: "list",
      projectRoot: workspace.projectRoot,
    });
    const candidateResult = await handleCodexTool("alembic_knowledge", {
      operation: "list",
      status: "candidate",
      projectRoot: workspace.projectRoot,
    });

    expect(activeResult.success).toBe(true);
    expect(candidateResult.success).toBe(true);
    const activeData = activeResult.data as {
      readonly status: string;
      readonly operation: string;
      readonly records: ReadonlyArray<{ readonly id: string; readonly status: string }>;
      readonly items: ReadonlyArray<{ readonly id: string; readonly status: string }>;
      readonly warnings: readonly string[];
      readonly dataRoot: string;
      readonly projectRoot: string;
    };
    const candidateData = candidateResult.data as typeof activeData;
    expect(activeData).toMatchObject({
      status: "completed",
      operation: "list",
      dataRoot: workspace.dataRoot,
      projectRoot: workspace.projectRoot,
      warnings: [],
    });
    expect(activeData.records).toMatchObject([{ id: "public-active-list", status: "active" }]);
    expect(activeData.items).toEqual(activeData.records);
    expect(candidateData.records).toMatchObject([
      { id: "public-candidate-list", status: "candidate" },
    ]);
  });

  it("publishes alembic_knowledge candidates into ContextIndex and SearchIndex", async () => {
    const workspace = initializeCodexWorkspace({
      projectRoot: currentProjectRoot(),
      standard: true,
    });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const lifecycle = new RecipeLifecycleStore(persistence.writeBoundary);
    await lifecycle.writeCandidate(
      lifecycleRecipe(
        "public-lifecycle-publish",
        "Publish public lifecycle recipes into the active search index.",
      ),
      { now: 20 },
    );

    const result = await handleCodexTool("alembic_knowledge", {
      operation: "publish",
      recipeId: "public-lifecycle-publish",
      reviewer: "codex-public-test",
      projectRoot: workspace.projectRoot,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      readonly status: string;
      readonly operation: string;
      readonly records: ReadonlyArray<{
        readonly id: string;
        readonly status: string;
        readonly file?: { readonly bucket: string };
      }>;
      readonly warnings: readonly string[];
      readonly dataRoot: string;
      readonly projectRoot: string;
    };
    expect(data).toMatchObject({
      status: "completed",
      operation: "publish",
      dataRoot: workspace.dataRoot,
      projectRoot: workspace.projectRoot,
      records: [
        {
          id: "public-lifecycle-publish",
          status: "active",
          file: { bucket: "recipes" },
        },
      ],
      warnings: [],
    });

    const restored = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    expect(restored.contextIndex.snapshot().recipes).toMatchObject([
      { id: "public-lifecycle-publish", status: "active" },
    ]);
    expect(restored.searchIndex.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "recipe:public-lifecycle-publish", kind: "recipe" }),
      ]),
    );

    const search = await handleCodexTool("alembic_search", {
      query: "active search index",
      projectRoot: workspace.projectRoot,
      limit: 5,
    });
    const searchData = search.data as {
      readonly hits: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
    };
    expect(searchData.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "recipe:public-lifecycle-publish", kind: "recipe" }),
      ]),
    );
  });

  it("rejects alembic_knowledge candidates without leaving them in active search", async () => {
    const workspace = initializeCodexWorkspace({
      projectRoot: currentProjectRoot(),
      standard: true,
    });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const lifecycle = new RecipeLifecycleStore(persistence.writeBoundary);
    const candidate = await lifecycle.writeCandidate(
      lifecycleRecipe(
        "public-lifecycle-reject",
        "Reject public lifecycle recipes before active search can use them.",
      ),
      { now: 30 },
    );
    await persistence.contextIndex.upsertContextArtifacts({
      recipes: [candidate.recipe],
      recipeFiles: recipeFilesFromRecord(candidate),
    });
    persistence.searchIndex.upsert(projectMainlineSearchDocuments({ recipes: [candidate.recipe] }));
    await persistence.searchIndex.flush();

    const before = await handleCodexTool("alembic_search", {
      query: "before active search",
      projectRoot: workspace.projectRoot,
      limit: 5,
    });
    expect(
      (before.data as { readonly hits: ReadonlyArray<{ readonly id: string }> }).hits.map(
        (hit) => hit.id,
      ),
    ).not.toContain("recipe:public-lifecycle-reject");

    const result = await handleCodexTool("alembic_knowledge", {
      operation: "reject",
      recipeId: "public-lifecycle-reject",
      reason: "Too narrow for public lifecycle knowledge.",
      reviewer: "codex-public-test",
      projectRoot: workspace.projectRoot,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      readonly status: string;
      readonly operation: string;
      readonly records: ReadonlyArray<{ readonly id: string; readonly status: string }>;
      readonly warnings: readonly string[];
    };
    expect(data).toMatchObject({
      status: "completed",
      operation: "reject",
      records: [{ id: "public-lifecycle-reject", status: "rejected" }],
      warnings: [],
    });

    const after = await handleCodexTool("alembic_search", {
      query: "before active search",
      projectRoot: workspace.projectRoot,
      limit: 5,
    });
    expect(
      (after.data as { readonly hits: ReadonlyArray<{ readonly id: string }> }).hits.map(
        (hit) => hit.id,
      ),
    ).not.toContain("recipe:public-lifecycle-reject");

    const rejectedList = await handleCodexTool("alembic_knowledge", {
      operation: "list",
      status: "rejected",
      projectRoot: workspace.projectRoot,
    });
    expect(
      (
        rejectedList.data as {
          readonly records: ReadonlyArray<{ readonly id: string; readonly status: string }>;
        }
      ).records,
    ).toMatchObject([{ id: "public-lifecycle-reject", status: "rejected" }]);
  });

  it("keeps alembic_knowledge outside internal Agent tool imports and envelopes", async () => {
    const sources = await Promise.all([
      fs.readFile(new URL("./tools.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./knowledge.ts", import.meta.url), "utf8"),
    ]);
    const importSpecifiers = sources.flatMap((source) =>
      [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]),
    );

    for (const specifier of importSpecifiers) {
      expect(specifier).not.toMatch(/(?:\.\.\/)*agent\/tools/);
      expect(specifier).not.toContain("lib/agent/tools");
    }

    const result = await handleCodexTool("alembic_knowledge", {
      operation: "list",
      projectRoot: currentProjectRoot(),
    });
    expect(JSON.stringify(result.data)).not.toContain("resource.action");
    expect(JSON.stringify(result.data)).not.toContain("ToolResultEnvelope");
  });
});

function currentProjectRoot(): string {
  const projectRoot = process.env.ALEMBIC_PROJECT_DIR;
  if (!projectRoot) {
    throw new Error("ALEMBIC_PROJECT_DIR is missing.");
  }
  return projectRoot;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function lifecycleRecipe(id: string, summary: string) {
  return createRecipe({
    id,
    title: id
      .split("-")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    kind: "workflow",
    status: "candidate",
    summary,
    trigger: summary,
    confidence: 0.9,
  });
}

function recipeFilesFromRecord(record: RecipeLifecycleRecord) {
  if (!record.file) {
    return [];
  }
  return [
    {
      recipeId: record.id,
      bucket: record.file.bucket,
      relativePath: record.file.relativePath,
      contentHash: record.file.contentHash,
      ...(record.metadata.updatedAt === undefined ? {} : { updatedAt: record.metadata.updatedAt }),
    },
  ];
}
