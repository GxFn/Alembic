import type { ToolRuntimeDependencies } from "../../agent/tools/index.js";
import {
  JsonMainlineProjectIntelligenceArtifactStore,
  MAINLINE_FILE_FINGERPRINT_SNAPSHOT_STORE_PATH,
  MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH,
  MainlineCompileSession,
  type MainlineProjectIntelligenceArtifactStore,
  sourceRefsFromRecipe,
} from "../../mainline/compile/index.js";
import {
  MainlineAtomicFileStore as CoreMainlineAtomicFileStore,
  type MainlineWorkspaceMode,
  MainlineWorkspacePaths,
  MainlineWriteBoundary,
} from "../../mainline/core/index.js";
import {
  type ContextIndexSnapshot,
  type ContextIndexWriteBatch,
  type ContextIndexWriteResult,
  InMemoryContextIndex,
} from "../../mainline/data/index.js";
import type {
  MainlineAtomicFileStore as JsonMainlineAtomicFileStore,
  MainlineZonedPath as JsonMainlineZonedPath,
} from "../../mainline/data/JsonStores.js";
import {
  type RecipeLifecycleRecord,
  RecipeLifecycleStore,
  type RecipeLifecycleStorePort,
  RecipeMarkdownStore,
} from "../../mainline/knowledge/index.js";
import {
  type InMemoryMainlineSearchIndex,
  type MainlineSearchDocument,
  type MainlineSearchHit,
  type MainlineSearchIndex,
  MainlineSearchIndexStore,
  type MainlineSearchQuery,
  projectMainlineSearchDocuments,
} from "../../mainline/search/index.js";
import { ScanLifecycleRunner } from "../scan/ScanLifecycleRunner.js";
import type {
  MainlineWorkflowEntrypointDependencies,
  MainlineWorkflowPersistedArtifacts,
  MainlineWorkflowPersistence as MainlineWorkflowSnapshotPersistence,
  MainlineWorkflowPersistenceInput as MainlineWorkflowSnapshotPersistenceInput,
} from "./MainlineWorkflowEntrypoint.js";

const MAINLINE_CONTEXT_INDEX_STORE_PATH = "context/context-index.json";
const MAINLINE_SEARCH_INDEX_STORE_PATH = "context/search-index.json";

export interface MainlineWorkflowPersistenceOptions {
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly mode?: MainlineWorkspaceMode;
  readonly now?: () => number;
}

export interface DataRootMainlineWorkflowPersistence {
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly writeBoundary: MainlineWriteBoundary;
  readonly dependencies: MainlineWorkflowEntrypointDependencies;
  readonly contextIndex: PersistentMainlineContextIndex;
  readonly searchIndex: PersistentMainlineSearchIndex;
  readonly artifactStore: MainlineProjectIntelligenceArtifactStore;
  readonly persistedArtifacts: MainlineWorkflowPersistedArtifacts;
  readonly agentToolDependencies: ToolRuntimeDependencies;
}

/**
 * 从 projectRoot/dataRoot 构造主线 workflow 的持久化依赖。
 * 中文说明：所有 workflow 产物都通过 MainlineWriteBoundary.data/runtime 落到 dataRoot；
 * projectRoot 只用于扫描源码，不能作为缓存、索引或 artifact 的写入边界。
 */
export async function createMainlineWorkflowPersistence(
  input: MainlineWorkflowPersistenceOptions,
): Promise<DataRootMainlineWorkflowPersistence> {
  const workspacePaths = new MainlineWorkspacePaths(input);
  const writeBoundary = new MainlineWriteBoundary({ workspacePaths });
  const coreFileStore = new CoreMainlineAtomicFileStore();
  const fileStore = new DataRootJsonFileStore(writeBoundary, coreFileStore);
  const persistedArtifacts = {
    artifactPath: runtimeAbsolute(writeBoundary, MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH),
    contextSnapshotPath: runtimeAbsolute(writeBoundary, MAINLINE_CONTEXT_INDEX_STORE_PATH),
    searchSnapshotPath: runtimeAbsolute(writeBoundary, MAINLINE_SEARCH_INDEX_STORE_PATH),
    fingerprintSnapshotPath: runtimeAbsolute(
      writeBoundary,
      MAINLINE_FILE_FINGERPRINT_SNAPSHOT_STORE_PATH,
    ),
    recipeMarkdownRoot: workspacePaths.recipesDir,
  };

  const contextIndex = await PersistentMainlineContextIndex.restore({
    target: dataStoreTarget(MAINLINE_CONTEXT_INDEX_STORE_PATH),
    fileStore,
  });
  const searchIndexStore = new MainlineSearchIndexStore(
    dataStoreTarget(MAINLINE_SEARCH_INDEX_STORE_PATH),
    fileStore,
    input.now ? { now: input.now } : {},
  );
  const searchIndex = new PersistentMainlineSearchIndex(
    await searchIndexStore.restoreIndex(),
    searchIndexStore,
  );
  const artifactStore = new FlushingMainlineProjectIntelligenceArtifactStore(
    new JsonMainlineProjectIntelligenceArtifactStore(
      dataStoreTarget(MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH),
      fileStore,
    ),
    [contextIndex, searchIndex],
  );
  const knowledgeLifecycleStore = new IndexingRecipeLifecycleStore(
    new RecipeLifecycleStore(writeBoundary, { fileStore: coreFileStore }),
    contextIndex,
    searchIndex,
  );
  const recipeMarkdownStore = new RecipeMarkdownStore(writeBoundary, { fileStore: coreFileStore });
  const persistence = new DataRootWorkflowSnapshotPersistence(
    contextIndex,
    searchIndex,
    persistedArtifacts,
  );
  const resetRuntimeState = async () => {
    await contextIndex.reset();
    searchIndex.clear();
    await searchIndex.flush();
  };
  const compileSession = new MainlineCompileSession({
    workspacePaths,
    writeBoundary,
    fileStore: coreFileStore,
    contextIndex,
    searchIndex,
    searchIndexStore,
    artifactStore,
    recipeMarkdownStore,
  });
  const now = input.now;
  const lifecycleRunner = new ScanLifecycleRunner({
    workspacePaths,
    compileSession,
    resetRuntimeState,
    persistedArtifacts,
    ...(now === undefined ? {} : { now: () => new Date(now()) }),
  });
  const agentToolDependencies = createMainlineAgentToolDependencies({
    projectRoot: workspacePaths.projectRoot,
    contextIndex,
    searchIndex,
    artifactStore,
    knowledgeLifecycleStore,
    sourceRefRepairIndex: contextIndex,
    sourceRefRepairMarkdownStore: recipeMarkdownStore,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  return {
    workspacePaths,
    writeBoundary,
    dependencies: {
      contextIndex,
      searchIndex,
      artifactStore,
      persistence,
      compileSession,
      lifecycleRunner,
      persistedArtifacts,
      resetRuntimeState,
    },
    contextIndex,
    searchIndex,
    artifactStore,
    persistedArtifacts,
    agentToolDependencies,
  };
}

export async function createMainlineWorkflowEntrypointDependencies(
  input: MainlineWorkflowPersistenceOptions,
): Promise<MainlineWorkflowEntrypointDependencies> {
  return (await createMainlineWorkflowPersistence(input)).dependencies;
}

export function createMainlineAgentToolDependencies(input: {
  readonly projectRoot: string;
  readonly contextIndex: PersistentMainlineContextIndex;
  readonly searchIndex: PersistentMainlineSearchIndex;
  readonly artifactStore: MainlineProjectIntelligenceArtifactStore;
  readonly knowledgeLifecycleStore: RecipeLifecycleStorePort;
  readonly sourceRefRepairIndex?: PersistentMainlineContextIndex;
  readonly sourceRefRepairMarkdownStore?: RecipeMarkdownStore;
  readonly now?: () => number;
}): ToolRuntimeDependencies {
  return {
    projectRoot: input.projectRoot,
    contextIndex: input.contextIndex,
    searchIndex: input.searchIndex,
    projectIntelligenceArtifactProvider: input.artifactStore,
    knowledgeLifecycleStore: input.knowledgeLifecycleStore,
    ...(input.sourceRefRepairIndex === undefined
      ? {}
      : { sourceRefRepairIndex: input.sourceRefRepairIndex }),
    ...(input.sourceRefRepairMarkdownStore === undefined
      ? {}
      : { sourceRefRepairMarkdownStore: input.sourceRefRepairMarkdownStore }),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
}

export class PersistentMainlineContextIndex extends InMemoryContextIndex {
  readonly #target: JsonMainlineZonedPath;
  readonly #fileStore: JsonMainlineAtomicFileStore;

  static async restore(options: {
    readonly target: JsonMainlineZonedPath;
    readonly fileStore: JsonMainlineAtomicFileStore;
  }): Promise<PersistentMainlineContextIndex> {
    return new PersistentMainlineContextIndex({
      ...options,
      snapshot: (await options.fileStore.readJson<ContextIndexSnapshot>(options.target)) ?? {},
    });
  }

  private constructor(options: {
    readonly target: JsonMainlineZonedPath;
    readonly fileStore: JsonMainlineAtomicFileStore;
    readonly snapshot: Partial<ContextIndexSnapshot>;
  }) {
    super(options.snapshot);
    this.#target = options.target;
    this.#fileStore = options.fileStore;
  }

  override async upsertContextArtifacts(
    batch: ContextIndexWriteBatch,
  ): Promise<ContextIndexWriteResult> {
    const result = await super.upsertContextArtifacts(batch);
    await this.flush();
    return result;
  }

  async flush(): Promise<void> {
    await this.#fileStore.writeJsonAtomic(this.#target, this.snapshot());
  }

  async reset(): Promise<void> {
    this.clear();
    await this.flush();
  }
}

export class PersistentMainlineSearchIndex implements MainlineSearchIndex {
  readonly #index: InMemoryMainlineSearchIndex;
  readonly #store: MainlineSearchIndexStore;
  #pendingSave: Promise<unknown> = Promise.resolve();

  constructor(index: InMemoryMainlineSearchIndex, store: MainlineSearchIndexStore) {
    this.#index = index;
    this.#store = store;
  }

  remove(documentIds: readonly string[]): void {
    this.#index.remove(documentIds);
    this.#queueSave();
  }

  upsert(documents: readonly MainlineSearchDocument[]): void {
    this.#index.upsert(documents);
    this.#queueSave();
  }

  search(query: MainlineSearchQuery): MainlineSearchHit[] {
    return this.#index.search(query);
  }

  snapshot(): MainlineSearchDocument[] {
    return this.#index.snapshot();
  }

  clear(): void {
    this.#index.clear();
    this.#queueSave();
  }

  async flush(): Promise<void> {
    await this.#pendingSave;
  }

  #queueSave(): void {
    const documents = this.#index.snapshot();
    this.#pendingSave = this.#pendingSave.then(() => this.#store.saveDocuments(documents));
  }
}

class DataRootWorkflowSnapshotPersistence implements MainlineWorkflowSnapshotPersistence {
  readonly #contextIndex: PersistentMainlineContextIndex;
  readonly #searchIndex: PersistentMainlineSearchIndex;
  readonly #persistedArtifacts: MainlineWorkflowPersistedArtifacts;

  constructor(
    contextIndex: PersistentMainlineContextIndex,
    searchIndex: PersistentMainlineSearchIndex,
    persistedArtifacts: MainlineWorkflowPersistedArtifacts,
  ) {
    this.#contextIndex = contextIndex;
    this.#searchIndex = searchIndex;
    this.#persistedArtifacts = persistedArtifacts;
  }

  async saveSnapshots(
    _input: MainlineWorkflowSnapshotPersistenceInput,
  ): Promise<MainlineWorkflowPersistedArtifacts> {
    // 中文注释：workflow 完成前强制 flush，确保 job result 返回时运行期快照已经可读。
    await Promise.all([this.#contextIndex.flush(), this.#searchIndex.flush()]);
    return this.#persistedArtifacts;
  }
}

class IndexingRecipeLifecycleStore implements RecipeLifecycleStorePort {
  readonly #inner: RecipeLifecycleStorePort;
  readonly #contextIndex: PersistentMainlineContextIndex;
  readonly #searchIndex: PersistentMainlineSearchIndex;

  constructor(
    inner: RecipeLifecycleStorePort,
    contextIndex: PersistentMainlineContextIndex,
    searchIndex: PersistentMainlineSearchIndex,
  ) {
    this.#inner = inner;
    this.#contextIndex = contextIndex;
    this.#searchIndex = searchIndex;
  }

  async writeCandidate(
    recipe: Parameters<RecipeLifecycleStorePort["writeCandidate"]>[0],
    options?: Parameters<RecipeLifecycleStorePort["writeCandidate"]>[1],
  ): ReturnType<RecipeLifecycleStorePort["writeCandidate"]> {
    const record = await this.#inner.writeCandidate(recipe, options);
    await this.#indexRecord(record);
    return record;
  }

  async publish(
    recipeId: Parameters<RecipeLifecycleStorePort["publish"]>[0],
    options?: Parameters<RecipeLifecycleStorePort["publish"]>[1],
  ): ReturnType<RecipeLifecycleStorePort["publish"]> {
    const record = await this.#inner.publish(recipeId, options);
    await this.#indexRecord(record);
    return record;
  }

  async reject(
    recipeId: Parameters<RecipeLifecycleStorePort["reject"]>[0],
    options?: Parameters<RecipeLifecycleStorePort["reject"]>[1],
  ): ReturnType<RecipeLifecycleStorePort["reject"]> {
    const record = await this.#inner.reject(recipeId, options);
    await this.#indexRecord(record);
    return record;
  }

  list(
    options?: Parameters<RecipeLifecycleStorePort["list"]>[0],
  ): ReturnType<RecipeLifecycleStorePort["list"]> {
    return this.#inner.list(options);
  }

  load(
    recipeId: Parameters<RecipeLifecycleStorePort["load"]>[0],
    options?: Parameters<RecipeLifecycleStorePort["load"]>[1],
  ): ReturnType<RecipeLifecycleStorePort["load"]> {
    return this.#inner.load(recipeId, options);
  }

  async #indexRecord(record: RecipeLifecycleRecord): Promise<void> {
    if (record.status === "candidate") {
      // 中文注释：candidate 只属于审核面，不能进入运行期 Context/Search，
      // 否则 prime、guard 和 agent runtime 会读到未发布知识。
      return;
    }

    if (record.status === "rejected") {
      const deleted = await this.#contextIndex.deleteRecipes([record.id]);
      this.#searchIndex.remove([
        `recipe:${record.id}`,
        ...deleted.sourceRefIds.map((sourceRefId) => `source-ref:${sourceRefId}`),
        ...record.recipe.sourceRefIds.map((sourceRefId) => `source-ref:${sourceRefId}`),
      ]);
      await Promise.all([this.#contextIndex.flush(), this.#searchIndex.flush()]);
      return;
    }

    const sourceRefs = sourceRefsFromRecipe(record.recipe, "recipe-lifecycle");
    await this.#contextIndex.upsertContextArtifacts({
      recipes: [record.recipe],
      sourceRefs,
      ...(record.file === undefined
        ? {}
        : {
            recipeFiles: [
              {
                recipeId: record.file.recipeId,
                bucket: record.file.bucket,
                relativePath: record.file.relativePath,
                contentHash: record.file.contentHash,
                ...(record.metadata.updatedAt === undefined
                  ? {}
                  : { updatedAt: record.metadata.updatedAt }),
              },
            ],
          }),
    });
    this.#searchIndex.upsert(
      projectMainlineSearchDocuments({ recipes: [record.recipe], sourceRefs }),
    );
    await this.#searchIndex.flush();
  }
}

class FlushingMainlineProjectIntelligenceArtifactStore
  implements MainlineProjectIntelligenceArtifactStore
{
  readonly #inner: MainlineProjectIntelligenceArtifactStore;
  readonly #flushers: readonly { flush(): Promise<void> }[];

  constructor(
    inner: MainlineProjectIntelligenceArtifactStore,
    flushers: readonly { flush(): Promise<void> }[],
  ) {
    this.#inner = inner;
    this.#flushers = flushers;
  }

  load() {
    return this.#inner.load();
  }

  async save(artifact: Parameters<MainlineProjectIntelligenceArtifactStore["save"]>[0]) {
    await Promise.all(this.#flushers.map((flusher) => flusher.flush()));
    await this.#inner.save(artifact);
  }
}

class DataRootJsonFileStore implements JsonMainlineAtomicFileStore {
  readonly #writeBoundary: MainlineWriteBoundary;
  readonly #fileStore: CoreMainlineAtomicFileStore;

  constructor(writeBoundary: MainlineWriteBoundary, fileStore: CoreMainlineAtomicFileStore) {
    this.#writeBoundary = writeBoundary;
    this.#fileStore = fileStore;
  }

  readText(target: JsonMainlineZonedPath): Promise<string | null> {
    return this.#fileStore.readText(this.#runtimeTarget(target));
  }

  readJson<T>(target: JsonMainlineZonedPath): Promise<T | null> {
    return this.#fileStore.readJson<T>(this.#runtimeTarget(target));
  }

  writeJsonAtomic(target: JsonMainlineZonedPath, value: unknown): Promise<void> {
    return this.#fileStore.writeJsonAtomic(this.#runtimeTarget(target), value);
  }

  appendJsonl(target: JsonMainlineZonedPath, value: unknown): Promise<void> {
    return this.#fileStore.appendJsonl(this.#runtimeTarget(target), value);
  }

  #runtimeTarget(target: JsonMainlineZonedPath) {
    return this.#writeBoundary.runtime(target.path);
  }
}

function dataStoreTarget(path: string): JsonMainlineZonedPath {
  return { path, zone: "data" };
}

function runtimeAbsolute(writeBoundary: MainlineWriteBoundary, path: string): string {
  return writeBoundary.runtime(path).absolute;
}
