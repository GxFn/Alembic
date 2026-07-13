import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import {
  asEmbeddingPort,
  buildRecipeVectorGenerationManifest,
  type RecipeRegionSourceEntry,
  type RecipeVectorGenerationBuildResult,
  type RecipeVectorGenerationManager,
  type RecipeVectorGenerationManifest,
  type RecipeVectorGenerationRoute,
  type RecipeVectorGenerationRouter,
  type RecipeVectorGenerationSource,
  type RecipeVectorGenerationStoreFactory,
  removeRecipeVectorsByTruth,
  VectorStore,
} from '@alembic/core/vector';

const logger = Logger.getInstance();
const ACTIVATION_LOCK_VERSION = 1;
const DEAD_OWNER_GRACE_MS = 1_000;
const UNKNOWN_LOCK_STALE_MS = 30_000;

interface ActivationLockRecord {
  version: typeof ACTIVATION_LOCK_VERSION;
  ownerPid: number;
  ownerToken: string;
  acquiredAt: number;
}

type VectorItem = {
  id: string;
  content: string;
  vector: number[];
  metadata: Record<string, unknown>;
};

type VectorSearchResult = { item: Record<string, unknown>; score: number };

interface RecipeKnowledgeService {
  list(
    filters: Record<string, unknown>,
    pagination: { page: number; pageSize: number }
  ): Promise<{ data?: unknown[]; items?: unknown[] }>;
}

interface EmbeddingProviderLike {
  embed?(texts: string | string[]): Promise<number[] | number[][]>;
  embedDocuments?(texts: readonly string[]): Promise<number[][]>;
  embedQuery?(text: string): Promise<number[]>;
  describeCapabilities?(): Record<string, unknown>;
}

export interface RecipeVectorGenerationRuntimeOptions {
  embedProvider: EmbeddingProviderLike | null;
  generationManager: RecipeVectorGenerationManager;
  knowledgeService: RecipeKnowledgeService;
  storage: FileRecipeVectorGenerationStorage;
}

/**
 * Alembic 宿主侧的 Recipe generation 运行时。
 *
 * dry-run 只计算 manifest；显式 rebuild 才允许创建 shadow 并切换 active pointer。
 * 自动维护在尚未完成首次显式迁移时保持 plan-only，避免启动/重扫偷偷改写旧索引。
 */
export class RecipeVectorGenerationRuntime {
  readonly #embedProvider: EmbeddingProviderLike | null;
  readonly #generationManager: RecipeVectorGenerationManager;
  readonly #knowledgeService: RecipeKnowledgeService;
  readonly #storage: FileRecipeVectorGenerationStorage;

  constructor(options: RecipeVectorGenerationRuntimeOptions) {
    this.#embedProvider = options.embedProvider;
    this.#generationManager = options.generationManager;
    this.#knowledgeService = options.knowledgeService;
    this.#storage = options.storage;
  }

  async dryRun(createdFrom: RecipeVectorGenerationSource = 'migration') {
    const entries = await this.#listAuthoritativeRecipes();
    const descriptor = this.#embeddingPort().describeCapabilities();
    const manifest = buildRecipeVectorGenerationManifest(entries, descriptor, {
      createdFrom,
      generationId: 'dry-run',
      status: 'building',
    });
    const active = await this.#storage.readActive();
    const activeManifest = active ? await this.#storage.readManifest(active.generationId) : null;
    return {
      status: 'dry-run' as const,
      writePerformed: false,
      active,
      manifest,
      changes: {
        corpusChanged: activeManifest?.corpusFingerprint !== manifest.corpusFingerprint,
        embeddingChanged:
          activeManifest?.provider !== manifest.provider ||
          activeManifest?.model !== manifest.model ||
          activeManifest?.dimension !== manifest.dimension,
        documentCount: manifest.documentCount,
        recipeCount: manifest.recipeCount,
      },
    };
  }

  async rebuild(
    createdFrom: RecipeVectorGenerationSource = 'full-build'
  ): Promise<RecipeVectorGenerationBuildResult> {
    const entries = await this.#listAuthoritativeRecipes();
    return this.#generationManager.buildAndActivate(
      entries,
      this.#embeddingPort() as Parameters<RecipeVectorGenerationManager['buildAndActivate']>[1],
      { createdFrom }
    );
  }

  async maintain(createdFrom: Exclude<RecipeVectorGenerationSource, 'migration'>) {
    const active = await this.#storage.readActive();
    if (!active) {
      const plan = await this.dryRun(createdFrom);
      return { ...plan, status: 'planned' as const };
    }
    return this.rebuild(createdFrom);
  }

  async rollback(generationId: string) {
    const normalizedId = generationId.trim();
    if (!normalizedId) {
      throw new Error('rollback generationId is required');
    }
    const manifest = await this.#storage.readManifest(normalizedId);
    if (!manifest || manifest.status !== 'ready') {
      throw new Error(`Recipe vector generation is not rollback-ready: ${normalizedId}`);
    }
    const switched = await this.#generationManager.rollback({
      generationId: manifest.generationId,
      manifestHash: manifest.manifestHash,
    });
    if (!switched) {
      throw new Error(`Recipe vector generation rollback compare-and-swap failed: ${normalizedId}`);
    }
    return { status: 'rolled-back' as const, generationId: normalizedId };
  }

  async status() {
    const active = await this.#storage.readActive();
    return {
      active,
      manifest: active ? await this.#storage.readManifest(active.generationId) : null,
    };
  }

  #embeddingPort() {
    if (!this.#embedProvider) {
      throw new Error('Recipe vector generation requires an embedding provider');
    }
    return asEmbeddingPort(this.#embedProvider as Parameters<typeof asEmbeddingPort>[0]);
  }

  async #listAuthoritativeRecipes(): Promise<RecipeRegionSourceEntry[]> {
    const result = await this.#knowledgeService.list({}, { page: 1, pageSize: 10_000 });
    const rows = result.data ?? result.items ?? [];
    return rows
      .map((row) => {
        if (row && typeof row === 'object' && 'toJSON' in row) {
          const toJSON = (row as { toJSON?: () => unknown }).toJSON;
          if (typeof toJSON === 'function') {
            return toJSON.call(row);
          }
        }
        return row;
      })
      .filter((row): row is RecipeRegionSourceEntry =>
        Boolean(
          row &&
            typeof row === 'object' &&
            typeof (row as Record<string, unknown>).id === 'string' &&
            (row as Record<string, unknown>).lifecycle !== 'deprecated'
        )
      );
  }
}

export interface FileRecipeVectorGenerationStorageOptions {
  baseStore?: VectorStore;
  createStore(root: string): VectorStore;
  dataRoot: string;
}

/** 文件系统 generation factory、CAS router 与跨 generation 终态删除器。 */
export class FileRecipeVectorGenerationStorage
  implements RecipeVectorGenerationStoreFactory, RecipeVectorGenerationRouter
{
  readonly generationsRoot: string;
  readonly #activePath: string;
  readonly #baseStore: VectorStore | null;
  readonly #createStore: (root: string) => VectorStore;
  readonly #lockPath: string;
  readonly #stores = new Map<string, VectorStore>();

  constructor(options: FileRecipeVectorGenerationStorageOptions) {
    const contextRoot = path.join(options.dataRoot, '.asd', 'context');
    this.generationsRoot = path.join(contextRoot, 'recipe-vector-generations');
    this.#activePath = path.join(contextRoot, 'recipe-vector-active.json');
    this.#lockPath = `${this.#activePath}.lock`;
    this.#createStore = options.createStore;
    this.#baseStore = options.baseStore ?? null;
  }

  async createShadow(generationId: string): Promise<VectorStore> {
    const root = this.#generationStoreRoot(generationId);
    await fs.mkdir(root, { recursive: true });
    return this.#store(generationId, root);
  }

  async open(generationId: string): Promise<VectorStore> {
    const root = this.#generationStoreRoot(generationId);
    await fs.access(root);
    return this.#store(generationId, root);
  }

  async writeManifest(
    generationId: string,
    manifest: RecipeVectorGenerationManifest
  ): Promise<void> {
    if (manifest.status === 'ready') {
      const store = this.#stores.get(generationId) as
        | (VectorStore & { flush?: () => Promise<void> })
        | undefined;
      await store?.flush?.();
    }
    const target = this.#manifestPath(generationId);
    await writeJsonAtomic(target, manifest);
  }

  async readManifest(generationId: string): Promise<RecipeVectorGenerationManifest | null> {
    return readJson<RecipeVectorGenerationManifest>(this.#manifestPath(generationId));
  }

  async readActive(): Promise<RecipeVectorGenerationRoute | null> {
    return readJson<RecipeVectorGenerationRoute>(this.#activePath);
  }

  async activate(
    next: RecipeVectorGenerationRoute,
    expectedPreviousGenerationId: string | null
  ): Promise<boolean> {
    await fs.mkdir(path.dirname(this.#activePath), { recursive: true });
    const owner: ActivationLockRecord = {
      version: ACTIVATION_LOCK_VERSION,
      ownerPid: process.pid,
      ownerToken: randomUUID(),
      acquiredAt: Date.now(),
    };
    let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      lock = await this.#acquireActivationLock(owner);
      if (!lock) {
        return false;
      }
      const current = await this.readActive();
      if ((current?.generationId ?? null) !== expectedPreviousGenerationId) {
        logger.warn('Recipe vector generation activation CAS rejected', {
          actualPreviousGenerationId: current?.generationId ?? null,
          expectedPreviousGenerationId,
          nextGenerationId: next.generationId,
        });
        return false;
      }
      await writeJsonAtomic(this.#activePath, next);
      return true;
    } finally {
      await lock?.close();
      if (lock) {
        await this.#releaseActivationLock(owner);
      }
    }
  }

  async removeRecipeByIdentity(recipeId: string): Promise<void> {
    const errors: string[] = [];
    if (this.#baseStore) {
      const result = await removeRecipeVectorsByTruth(this.#baseStore, recipeId);
      errors.push(...result.errors.map((error) => `base:${error}`));
      await (this.#baseStore as VectorStore & { flush?: () => Promise<void> }).flush?.();
    }
    for (const generationId of await this.listGenerationIds()) {
      try {
        const store = await this.open(generationId);
        const result = await removeRecipeVectorsByTruth(store, recipeId);
        errors.push(...result.errors.map((error) => `${generationId}:${error}`));
        await (store as VectorStore & { flush?: () => Promise<void> }).flush?.();
      } catch (error: unknown) {
        errors.push(`${generationId}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`Recipe vector truth removal incomplete: ${errors.join('; ')}`);
    }
  }

  async listGenerationIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.generationsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  #generationStoreRoot(generationId: string) {
    return path.join(this.generationsRoot, safeGenerationId(generationId), 'store');
  }

  #manifestPath(generationId: string) {
    return path.join(this.generationsRoot, safeGenerationId(generationId), 'manifest.json');
  }

  #store(generationId: string, root: string) {
    const cached = this.#stores.get(generationId);
    if (cached) {
      return cached;
    }
    const created = this.#createStore(root);
    this.#stores.set(generationId, created);
    return created;
  }

  async #acquireActivationLock(owner: ActivationLockRecord) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = await fs.open(this.#lockPath, 'wx');
        try {
          await lock.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
          await lock.sync();
          return lock;
        } catch (error: unknown) {
          await lock.close();
          await fs.rm(this.#lockPath, { force: true });
          throw error;
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if (!(await this.#reclaimStaleActivationLock())) {
          return null;
        }
      }
    }
    return null;
  }

  async #reclaimStaleActivationLock(): Promise<boolean> {
    let raw: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      [raw, stat] = await Promise.all([
        fs.readFile(this.#lockPath, 'utf8'),
        fs.stat(this.#lockPath),
      ]);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw error;
    }

    const record = parseActivationLock(raw);
    const now = Date.now();
    let staleReason: string | null = null;
    if (record) {
      const ageMs = Math.max(0, now - record.acquiredAt);
      if (!isProcessAlive(record.ownerPid) && ageMs >= DEAD_OWNER_GRACE_MS) {
        staleReason = 'owner-process-not-alive';
      } else {
        logger.warn('Recipe vector activation is held by a live foreign owner', {
          ageMs,
          ownerPid: record.ownerPid,
        });
        return false;
      }
    } else {
      const ageMs = Math.max(0, now - stat.mtimeMs);
      if (ageMs >= UNKNOWN_LOCK_STALE_MS) {
        staleReason = 'legacy-or-malformed-lock-timed-out';
      } else {
        logger.warn(
          'Recipe vector activation lock is unreadable but still within its grace period',
          {
            ageMs,
          }
        );
        return false;
      }
    }

    // 删除前再次比对 inode、内容和 mtime，避免把检查后刚换入的 foreign lock 当成 stale。
    try {
      const [latestRaw, latestStat] = await Promise.all([
        fs.readFile(this.#lockPath, 'utf8'),
        fs.stat(this.#lockPath),
      ]);
      if (latestRaw !== raw || latestStat.ino !== stat.ino || latestStat.mtimeMs !== stat.mtimeMs) {
        logger.warn(
          'Recipe vector activation lock changed during stale recovery; recovery aborted',
          {
            staleReason,
          }
        );
        return false;
      }
      await fs.rm(this.#lockPath);
      logger.warn('Recovered stale Recipe vector activation lock', {
        ownerPid: record?.ownerPid ?? null,
        staleReason,
      });
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw error;
    }
  }

  async #releaseActivationLock(owner: ActivationLockRecord): Promise<void> {
    try {
      const current = parseActivationLock(await fs.readFile(this.#lockPath, 'utf8'));
      if (current?.ownerToken !== owner.ownerToken) {
        logger.warn('Recipe vector activation lock ownership changed; foreign lock was preserved', {
          ownerPid: current?.ownerPid ?? null,
        });
        return;
      }
      await fs.rm(this.#lockPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

/**
 * 通用向量保留在 base store；Recipe region 读写跟随 active generation。
 * 这样 generation 切换不会复制或清空 code/non-Recipe vectors。
 */
export class GenerationRoutingVectorStore extends VectorStore {
  readonly #base: VectorStore;
  readonly #storage: FileRecipeVectorGenerationStorage;
  #invalidActiveSignature: string | null = null;

  constructor(base: VectorStore, storage: FileRecipeVectorGenerationStorage) {
    super();
    this.#base = base;
    this.#storage = storage;
  }

  async init(): Promise<void> {
    await this.#base.init();
  }

  async upsert(item: VectorItem): Promise<void> {
    const store = await this.#writeStore(item);
    await store.upsert(item);
  }

  async batchUpsert(items: VectorItem[]): Promise<void> {
    const recipeItems = items.filter(isRecipeVectorItem);
    const baseItems = items.filter((item) => !isRecipeVectorItem(item));
    if (baseItems.length > 0) {
      await this.#base.batchUpsert(baseItems);
    }
    if (recipeItems.length > 0) {
      const active = await this.#verifiedActiveStore();
      if (!active) {
        throw new Error('recipe-vector-generation-not-active');
      }
      await active.batchUpsert(recipeItems);
    }
  }

  async remove(id: string): Promise<void> {
    if (id.startsWith('recipe_region_')) {
      const active = await this.#verifiedActiveStore();
      if (active) {
        await active.remove(id);
      }
    }
    await this.#base.remove(id);
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const active = await this.#verifiedActiveStore();
    if (id.startsWith('recipe_region_')) {
      return (await active?.getById(id)) ?? null;
    }
    if (active && isRecipeVectorId(id)) {
      return null;
    }
    return this.#base.getById(id);
  }

  async searchVector(
    queryVector: number[],
    options?: Record<string, unknown>
  ): Promise<VectorSearchResult[]> {
    const active = await this.#verifiedActiveStore();
    const baseResults = filterBaseResults(
      await this.#base.searchVector(queryVector, options),
      Boolean(active)
    );
    const activeResults = active ? await active.searchVector(queryVector, options) : [];
    return mergeRanked([...baseResults, ...activeResults], Number(options?.topK ?? 10));
  }

  async searchByFilter(filter: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const active = await this.#verifiedActiveStore();
    const baseResults = filterBaseResults(await this.#base.searchByFilter(filter), Boolean(active));
    const activeResults = active ? await active.searchByFilter(filter) : [];
    return uniqueItems([...baseResults, ...activeResults]);
  }

  async listIds(): Promise<string[]> {
    const active = await this.#verifiedActiveStore();
    const baseIds = await this.#base.listIds();
    if (!active) {
      return baseIds;
    }
    const genericBaseIds = baseIds.filter((id) => !isRecipeVectorId(id));
    return [...new Set([...genericBaseIds, ...(await active.listIds())])];
  }

  async clear(): Promise<void> {
    // Recipe generation 只能经 shadow + CAS 替换；legacy clear 仅清通用 base store。
    await this.#base.clear();
  }

  async getStats() {
    const active = await this.#verifiedActiveStore();
    const stores = active ? [this.#base, active] : [this.#base];
    const [stats, visibleIds] = await Promise.all([
      Promise.all(stores.map((store) => store.getStats())),
      this.listIds(),
    ]);
    return {
      count: visibleIds.length,
      indexSize: stats.reduce((sum, item) => sum + item.indexSize, 0),
    };
  }

  async query(queryVector: number[], topK = 10) {
    const active = await this.#verifiedActiveStore();
    const baseResults = filterBaseResults(
      await queryStore(this.#base, queryVector, topK),
      Boolean(active)
    );
    const activeResults = active ? await queryStore(active, queryVector, topK) : [];
    return mergeGenericRanked([...baseResults, ...activeResults], topK);
  }

  async hybridSearch(
    queryVector: number[] | null,
    queryText: string,
    options: Record<string, unknown> = {}
  ) {
    const active = await this.#verifiedActiveStore();
    const baseResults = filterBaseResults(
      await hybridSearchStore(this.#base, queryVector, queryText, options),
      Boolean(active)
    );
    const activeResults = active
      ? await hybridSearchStore(active, queryVector, queryText, options)
      : [];
    return mergeGenericRanked([...baseResults, ...activeResults], Number(options.topK ?? 10));
  }

  destroy(): void {
    this.#base.destroy();
  }

  async #verifiedActiveStore() {
    const active = await this.#storage.readActive();
    if (!active) {
      this.#invalidActiveSignature = null;
      return null;
    }
    const manifest = await this.#storage.readManifest(active.generationId);
    if (manifest?.status !== 'ready' || manifest.manifestHash !== active.manifestHash) {
      this.#logInvalidActive(active, manifest, 'manifest-not-verified');
      return null;
    }
    try {
      const store = await this.#storage.open(active.generationId);
      this.#invalidActiveSignature = null;
      return store;
    } catch (error: unknown) {
      this.#logInvalidActive(active, manifest, 'generation-store-unavailable', error);
      return null;
    }
  }

  async #writeStore(item: VectorItem) {
    if (!isRecipeVectorItem(item)) {
      return this.#base;
    }
    const active = await this.#verifiedActiveStore();
    if (!active) {
      throw new Error('recipe-vector-generation-not-active');
    }
    return active;
  }

  #logInvalidActive(
    active: RecipeVectorGenerationRoute,
    manifest: RecipeVectorGenerationManifest | null,
    reason: string,
    error?: unknown
  ) {
    const signature = `${active.generationId}:${active.manifestHash}:${manifest?.status ?? 'missing'}:${manifest?.manifestHash ?? 'missing'}:${reason}`;
    if (this.#invalidActiveSignature === signature) {
      return;
    }
    this.#invalidActiveSignature = signature;
    logger.warn(
      'Recipe vector active generation is not verified; legacy base reads remain enabled',
      {
        generationId: active.generationId,
        pointerManifestHash: active.manifestHash,
        manifestHash: manifest?.manifestHash ?? null,
        manifestStatus: manifest?.status ?? 'missing',
        reason,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      }
    );
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function safeGenerationId(generationId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(generationId)) {
    throw new Error(`Invalid Recipe vector generation id: ${generationId}`);
  }
  return generationId;
}

function parseActivationLock(raw: string): ActivationLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ActivationLockRecord>;
    if (
      value.version !== ACTIVATION_LOCK_VERSION ||
      !Number.isInteger(value.ownerPid) ||
      Number(value.ownerPid) <= 0 ||
      typeof value.ownerToken !== 'string' ||
      value.ownerToken.length === 0 ||
      typeof value.acquiredAt !== 'number' ||
      !Number.isFinite(value.acquiredAt)
    ) {
      return null;
    }
    return value as ActivationLockRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function isRecipeVectorItem(item: VectorItem) {
  return item.id.startsWith('recipe_region_') || item.metadata?.type === 'recipe-semantic-region';
}

function isRecipeSearchValue(value: unknown) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const item =
    record.item && typeof record.item === 'object'
      ? (record.item as Record<string, unknown>)
      : record;
  const metadata =
    item.metadata && typeof item.metadata === 'object'
      ? (item.metadata as Record<string, unknown>)
      : {};
  return (
    String(item.id ?? '').startsWith('entry_') ||
    String(item.id ?? '').startsWith('recipe_region_') ||
    metadata.type === 'recipe-semantic-region'
  );
}

function isRecipeVectorId(id: string) {
  return id.startsWith('entry_') || id.startsWith('recipe_region_');
}

function filterBaseResults<T>(items: T[], hasVerifiedActive: boolean): T[] {
  return hasVerifiedActive ? items.filter((item) => !isRecipeSearchValue(item)) : items;
}

async function queryStore(store: VectorStore, queryVector: number[], topK: number) {
  const query = (
    store as VectorStore & {
      query?: (vector: number[], limit: number) => Promise<unknown[]>;
    }
  ).query;
  return query ? query.call(store, queryVector, topK) : [];
}

async function hybridSearchStore(
  store: VectorStore,
  queryVector: number[] | null,
  queryText: string,
  options: Record<string, unknown>
) {
  const hybrid = (
    store as VectorStore & {
      hybridSearch?: (
        vector: number[] | null,
        text: string,
        opts: Record<string, unknown>
      ) => Promise<unknown[]>;
    }
  ).hybridSearch;
  return hybrid ? hybrid.call(store, queryVector, queryText, options) : [];
}

function itemId(value: unknown) {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  const item = record.item as Record<string, unknown> | undefined;
  const metadata = item?.metadata as Record<string, unknown> | undefined;
  return String(record.id ?? item?.id ?? metadata?.id ?? JSON.stringify(value));
}

function uniqueItems<T>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(itemId(item), item);
  }
  return [...byId.values()];
}

function mergeRanked(items: VectorSearchResult[], topK: number) {
  return uniqueItems(items.sort((left, right) => right.score - left.score)).slice(0, topK);
}

function mergeGenericRanked(items: unknown[], topK: number) {
  return uniqueItems(items)
    .sort((left, right) => genericScore(right) - genericScore(left))
    .slice(0, topK);
}

function genericScore(value: unknown) {
  if (!value || typeof value !== 'object') {
    return 0;
  }
  const record = value as Record<string, unknown>;
  return Number(record.score ?? record.similarity ?? 0);
}
