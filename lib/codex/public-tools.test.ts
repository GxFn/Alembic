import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainlineProjectIntelligenceBuilder } from "../mainline/graph/index.js";
import { createRecipe, createSourceRef } from "../mainline/knowledge/index.js";
import { projectMainlineSearchDocuments } from "../mainline/search/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { CODEX_TOOLS, handleCodexTool } from "./tools.js";
import { initializeCodexWorkspace } from "./workspace.js";

const tempRoots: string[] = [];

let previousAlembicHome: string | undefined;
let previousHome: string | undefined;
let previousProjectDir: string | undefined;

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-public-tools-home-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-public-tools-project-"));
  tempRoots.push(home, projectRoot);

  previousAlembicHome = process.env.ALEMBIC_HOME;
  previousHome = process.env.HOME;
  previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
  process.env.ALEMBIC_HOME = path.join(home, ".asd");
  process.env.HOME = home;
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
});

afterEach(async () => {
  restoreEnv("ALEMBIC_HOME", previousAlembicHome);
  restoreEnv("HOME", previousHome);
  restoreEnv("ALEMBIC_PROJECT_DIR", previousProjectDir);
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("Codex public search and structure tools", () => {
  it("registers stable public tool names and schemas", () => {
    const searchTool = CODEX_TOOLS.find((tool) => tool.name === "alembic_search");
    const structureTool = CODEX_TOOLS.find((tool) => tool.name === "alembic_structure");

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
