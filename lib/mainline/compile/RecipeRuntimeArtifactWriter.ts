import {
  MainlineAtomicFileStore,
  type MainlineWorkspacePathSnapshot,
  MainlineWorkspacePaths,
  MainlineWriteBoundary,
  normalizeMainlinePosixPath,
} from "../core/index.js";
import {
  type ContextIndex,
  type ContextIndexSnapshot,
  InMemoryContextIndex,
  type RecipeMarkdownFileIndex,
} from "../data/index.js";
import {
  type MainlineAtomicFileStore as MainlineJsonAtomicFileStore,
  MainlineJsonDocumentStore,
  type MainlineZonedPath as MainlineJsonZonedPath,
} from "../data/JsonStores.js";
import {
  createSourceRef,
  type Recipe,
  RecipeMarkdownStore,
  type RecipeMarkdownWriteResult,
  type SourceRef,
} from "../knowledge/index.js";
import { type MainlineSearchIndex, MainlineSearchIndexStore } from "../search/index.js";
import { MainlineCompileSearchMaterializer } from "./CompileSearchMaterializer.js";

export const MAINLINE_RUNTIME_CONTEXT_INDEX_STORE_PATH = "context/context-index.json";
export const MAINLINE_RUNTIME_SEARCH_INDEX_STORE_PATH = "context/search-index.json";

export interface MainlineRecipeRuntimeArtifactWriteInput {
  readonly projectRoot: string;
  readonly dataRoot?: string;
  readonly recipe: Recipe;
  readonly source?: string;
  readonly metadata?: Record<string, unknown>;
  readonly fileStore?: MainlineAtomicFileStore;
  readonly contextIndex?: ContextIndex;
  readonly searchIndex?: MainlineSearchIndex;
  readonly searchIndexStore?: MainlineSearchIndexStore;
}

export interface MainlineRecipeRuntimeArtifactWriteResult {
  readonly recipeId: string;
  readonly recipe: Recipe;
  readonly markdown: RecipeMarkdownWriteResult;
  readonly sourceRefs: readonly SourceRef[];
  readonly searchDocumentCount: number;
  readonly workspace: MainlineWorkspacePathSnapshot;
}

export interface MainlineRecipeRuntimeArtifactDeleteInput {
  readonly projectRoot: string;
  readonly dataRoot?: string;
  readonly recipeIds: readonly string[];
  readonly source?: string;
  readonly metadata?: Record<string, unknown>;
  readonly fileStore?: MainlineAtomicFileStore;
  readonly contextIndex?: ContextIndex;
  readonly searchIndex?: MainlineSearchIndex;
  readonly searchIndexStore?: MainlineSearchIndexStore;
}

export interface MainlineRecipeRuntimeArtifactDeleteResult {
  readonly recipeIds: readonly string[];
  readonly sourceRefIds: readonly string[];
  readonly markdownPaths: readonly string[];
  readonly deletedMarkdownPaths: readonly string[];
  readonly searchDocumentIds: readonly string[];
  readonly workspace: MainlineWorkspacePathSnapshot;
}

interface RuntimeArtifactStoreRuntime {
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly writeBoundary: MainlineWriteBoundary;
  readonly fileStore: MainlineAtomicFileStore;
  readonly markdownStore: RecipeMarkdownStore;
  readonly contextIndex: ContextIndex;
  readonly ownedContextIndex?: InMemoryContextIndex;
  readonly searchIndex: MainlineSearchIndex;
  readonly contextSnapshotStore?: MainlineJsonDocumentStore<ContextIndexSnapshot>;
  readonly searchIndexStore: MainlineSearchIndexStore;
}

/**
 * 将单条 Recipe 写入主线运行期产物。
 *
 * 中文注释：新仓库不引入 legacy SQLite 适配；默认使用 dataRoot 下的 JSON ContextIndex
 * 和 SearchIndex 快照，确保 Codex 插件冷启动、增量扫描、Agent tool 都读同一套主线产物。
 */
export async function writeRecipeToMainlineRuntimeArtifacts(
  input: MainlineRecipeRuntimeArtifactWriteInput,
): Promise<MainlineRecipeRuntimeArtifactWriteResult> {
  const runtime = await createRuntimeArtifactStoreRuntime(input);
  const markdown = await runtime.markdownStore.write(input.recipe);
  const sourceRefs = sourceRefsFromRecipe(input.recipe, input.source ?? "recipe-runtime-write");
  await runtime.contextIndex.upsertContextArtifacts({
    recipes: [input.recipe],
    recipeFiles: [recipeFileFromWrite(markdown)],
    sourceRefs,
  });
  await flushRuntimeContext(runtime);

  const materialized = await new MainlineCompileSearchMaterializer({
    searchIndex: runtime.searchIndex,
  }).materialize({
    recipes: [input.recipe],
    sourceRefs,
  });
  await flushRuntimeSearch(runtime);

  return {
    recipeId: input.recipe.id,
    recipe: input.recipe,
    markdown,
    sourceRefs,
    searchDocumentCount: materialized.searchDocuments.length,
    workspace: runtime.workspacePaths.snapshot(),
  };
}

/**
 * 删除主线运行期产物。
 *
 * 中文注释：删除路径同步处理 ContextIndex、SearchIndex 和 Recipe Markdown；
 * 调用方不需要知道底层是 JSON 快照还是未来的数据库 adapter。
 */
export async function deleteRecipesFromMainlineRuntimeArtifacts(
  input: MainlineRecipeRuntimeArtifactDeleteInput,
): Promise<MainlineRecipeRuntimeArtifactDeleteResult> {
  const runtime = await createRuntimeArtifactStoreRuntime(input);
  const deleted = await runtime.contextIndex.deleteRecipes(input.recipeIds);
  await flushRuntimeContext(runtime);

  const searchDocumentIds = [
    ...deleted.recipeIds.map((recipeId) => `recipe:${recipeId}`),
    ...deleted.sourceRefIds.map((sourceRefId) => `source-ref:${sourceRefId}`),
  ];
  runtime.searchIndex.remove(searchDocumentIds);
  await flushRuntimeSearch(runtime);

  const markdownPaths = deleted.recipeFiles.map((file) => file.relativePath);
  const deletedMarkdownPaths: string[] = [];
  for (const relativePath of markdownPaths) {
    if (await runtime.markdownStore.deleteFile({ relativePath })) {
      deletedMarkdownPaths.push(relativePath);
    }
  }

  return {
    recipeIds: deleted.recipeIds,
    sourceRefIds: deleted.sourceRefIds,
    markdownPaths,
    deletedMarkdownPaths,
    searchDocumentIds,
    workspace: runtime.workspacePaths.snapshot(),
  };
}

async function createRuntimeArtifactStoreRuntime(
  input: Pick<
    MainlineRecipeRuntimeArtifactWriteInput,
    "projectRoot" | "dataRoot" | "fileStore" | "contextIndex" | "searchIndex" | "searchIndexStore"
  >,
): Promise<RuntimeArtifactStoreRuntime> {
  const workspacePaths = new MainlineWorkspacePaths({
    projectRoot: input.projectRoot,
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  const writeBoundary = new MainlineWriteBoundary({ workspacePaths });
  const fileStore = input.fileStore ?? new MainlineAtomicFileStore();
  const markdownStore = new RecipeMarkdownStore(writeBoundary, { fileStore });
  const jsonFileStore = new RuntimeJsonFileStore(writeBoundary, fileStore);
  const contextSnapshotStore = input.contextIndex
    ? undefined
    : new MainlineJsonDocumentStore<ContextIndexSnapshot>(
        dataStoreTarget(MAINLINE_RUNTIME_CONTEXT_INDEX_STORE_PATH),
        jsonFileStore,
      );
  const ownedContextIndex = input.contextIndex
    ? undefined
    : new InMemoryContextIndex((await contextSnapshotStore?.load()) ?? undefined);
  const contextIndex = input.contextIndex ?? ownedContextIndex;
  if (!contextIndex) {
    throw new Error("Recipe runtime artifact writer failed to create ContextIndex.");
  }
  const searchIndexStore =
    input.searchIndexStore ??
    new MainlineSearchIndexStore(
      dataStoreTarget(MAINLINE_RUNTIME_SEARCH_INDEX_STORE_PATH),
      jsonFileStore,
    );
  const searchIndex = input.searchIndex ?? (await searchIndexStore.restoreIndex());

  return {
    workspacePaths,
    writeBoundary,
    fileStore,
    markdownStore,
    contextIndex,
    ...(ownedContextIndex === undefined ? {} : { ownedContextIndex }),
    searchIndex,
    ...(contextSnapshotStore === undefined ? {} : { contextSnapshotStore }),
    searchIndexStore,
  };
}

function recipeFileFromWrite(write: RecipeMarkdownWriteResult): RecipeMarkdownFileIndex {
  return {
    recipeId: write.recipeId,
    bucket: write.bucket,
    relativePath: write.relativePath,
    contentHash: write.contentHash,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

function sourceRefsFromRecipe(recipe: Recipe, source: string): SourceRef[] {
  return recipe.sourceRefIds.flatMap((sourceRefId) => {
    const parsed = parseSourceRefPath(sourceRefId);
    if (!parsed) {
      return [];
    }
    return [
      createSourceRef({
        id: sourceRefId,
        kind: parsed.symbol ? "symbol" : "file",
        path: parsed.path,
        ...(parsed.symbol === undefined ? {} : { symbol: parsed.symbol }),
        status: "unknown",
        summary: `Submitted Recipe source reference for ${recipe.title}`,
        metadata: {
          source,
          recipeId: recipe.id,
        },
      }),
    ];
  });
}

function parseSourceRefPath(
  sourceRefId: string,
): { readonly path: string; readonly symbol?: string } | null {
  const trimmed = sourceRefId.trim();
  if (!trimmed || trimmed.startsWith("symbol:")) {
    return null;
  }

  const hashIndex = trimmed.indexOf("#");
  const doubleColonIndex = trimmed.indexOf("::");
  const splitIndex =
    hashIndex >= 0 && doubleColonIndex >= 0
      ? Math.min(hashIndex, doubleColonIndex)
      : Math.max(hashIndex, doubleColonIndex);
  const rawPath = splitIndex >= 0 ? trimmed.slice(0, splitIndex) : trimmed;
  const rawSymbol =
    splitIndex >= 0 ? trimmed.slice(splitIndex + (hashIndex === splitIndex ? 1 : 2)) : "";
  const pathWithoutLine = rawPath.replace(/:\d+(?::\d+)?$/, "");
  const normalizedPath = normalizeMainlinePosixPath(pathWithoutLine);
  if (!looksLikeProjectPath(normalizedPath)) {
    return null;
  }
  const symbol = rawSymbol.trim();
  return {
    path: normalizedPath,
    ...(symbol ? { symbol } : {}),
  };
}

async function flushRuntimeContext(runtime: RuntimeArtifactStoreRuntime): Promise<void> {
  if (runtime.contextSnapshotStore && runtime.ownedContextIndex) {
    await runtime.contextSnapshotStore.save(runtime.ownedContextIndex.snapshot());
  }
}

async function flushRuntimeSearch(runtime: RuntimeArtifactStoreRuntime): Promise<void> {
  await runtime.searchIndexStore.saveDocuments(runtime.searchIndex.snapshot());
}

function looksLikeProjectPath(value: string): boolean {
  return value.includes("/") || /\.[A-Za-z0-9]+$/.test(value);
}

class RuntimeJsonFileStore implements MainlineJsonAtomicFileStore {
  readonly #writeBoundary: MainlineWriteBoundary;
  readonly #fileStore: MainlineAtomicFileStore;

  constructor(writeBoundary: MainlineWriteBoundary, fileStore: MainlineAtomicFileStore) {
    this.#writeBoundary = writeBoundary;
    this.#fileStore = fileStore;
  }

  readText(target: MainlineJsonZonedPath): Promise<string | null> {
    return this.#fileStore.readText(this.#runtimeTarget(target));
  }

  readJson<T>(target: MainlineJsonZonedPath): Promise<T | null> {
    return this.#fileStore.readJson<T>(this.#runtimeTarget(target));
  }

  writeJsonAtomic(target: MainlineJsonZonedPath, value: unknown): Promise<void> {
    return this.#fileStore.writeJsonAtomic(this.#runtimeTarget(target), value);
  }

  appendJsonl(target: MainlineJsonZonedPath, value: unknown): Promise<void> {
    return this.#fileStore.appendJsonl(this.#runtimeTarget(target), value);
  }

  #runtimeTarget(target: MainlineJsonZonedPath) {
    return this.#writeBoundary.runtime(target.path);
  }
}

function dataStoreTarget(path: string): MainlineJsonZonedPath {
  return { path, zone: "data" };
}
