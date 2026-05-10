import {
  JsonMainlineProjectIntelligenceArtifactStore,
  MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH,
  type MainlineProjectIntelligenceArtifactStore,
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
  type InMemoryMainlineSearchIndex,
  type MainlineSearchDocument,
  type MainlineSearchIndex,
  MainlineSearchIndexStore,
} from "../../mainline/search/index.js";
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
  const fileStore = new DataRootJsonFileStore(writeBoundary, new CoreMainlineAtomicFileStore());
  const persistedArtifacts = {
    artifactPath: runtimeAbsolute(writeBoundary, MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH),
    contextSnapshotPath: runtimeAbsolute(writeBoundary, MAINLINE_CONTEXT_INDEX_STORE_PATH),
    searchSnapshotPath: runtimeAbsolute(writeBoundary, MAINLINE_SEARCH_INDEX_STORE_PATH),
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
  const persistence = new DataRootWorkflowSnapshotPersistence(
    contextIndex,
    searchIndex,
    persistedArtifacts,
  );

  return {
    workspacePaths,
    writeBoundary,
    dependencies: {
      contextIndex,
      searchIndex,
      artifactStore,
      persistence,
    },
    contextIndex,
    searchIndex,
    artifactStore,
    persistedArtifacts,
  };
}

export async function createMainlineWorkflowEntrypointDependencies(
  input: MainlineWorkflowPersistenceOptions,
): Promise<MainlineWorkflowEntrypointDependencies> {
  return (await createMainlineWorkflowPersistence(input)).dependencies;
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
}

export class PersistentMainlineSearchIndex
  implements Pick<MainlineSearchIndex, "remove" | "upsert">
{
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

  snapshot(): MainlineSearchDocument[] {
    return this.#index.snapshot();
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
