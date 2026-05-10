import fs from "node:fs/promises";
import path from "node:path";

export interface MainlineVectorItem {
  readonly id: string;
  readonly vector: readonly number[];
  readonly content?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MainlineVectorSearchHit {
  readonly item: MainlineVectorItem;
  readonly score: number;
}

export interface MainlineVectorSearchOptions {
  readonly limit?: number;
  readonly minScore?: number;
  readonly filter?: Record<string, unknown>;
}

export interface MainlineVectorStore {
  upsert(items: readonly MainlineVectorItem[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  search(
    vector: readonly number[],
    options?: MainlineVectorSearchOptions,
  ): Promise<MainlineVectorSearchHit[]>;
  get(id: string): Promise<MainlineVectorItem | undefined>;
  snapshot(): Promise<MainlineVectorItem[]>;
}

/**
 * 内存向量存储是主线向量接口的基准实现。
 * 中文注释：它用线性扫描换确定性和零 native 依赖，适合 Codex 插件冷启动、
 * 单项目 Recipe 检索和单元测试；大规模向量库仍可通过同一端口替换。
 */
export class InMemoryMainlineVectorStore implements MainlineVectorStore {
  protected readonly items = new Map<string, MainlineVectorItem>();

  async upsert(items: readonly MainlineVectorItem[]): Promise<void> {
    for (const item of items) {
      this.items.set(item.id, normalizeVectorItem(item));
    }
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.items.delete(id);
    }
  }

  async search(
    vector: readonly number[],
    options: MainlineVectorSearchOptions = {},
  ): Promise<MainlineVectorSearchHit[]> {
    if (vector.length === 0) {
      return [];
    }
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? 0;
    return [...this.items.values()]
      .filter((item) => matchesMetadataFilter(item.metadata ?? {}, options.filter))
      .map((item) => ({ item, score: cosineSimilarity(vector, item.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
      .slice(0, limit);
  }

  async get(id: string): Promise<MainlineVectorItem | undefined> {
    return this.items.get(id);
  }

  async snapshot(): Promise<MainlineVectorItem[]> {
    return [...this.items.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

/**
 * JSON fallback 向量存储。
 * 中文注释：它不追求大规模性能，只保证没有外部向量库时主线仍能把
 * embedding 结果持久化，并在 daemon 重启后恢复语义检索。
 */
export class JsonMainlineVectorStore extends InMemoryMainlineVectorStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    super();
    this.#filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as { items?: MainlineVectorItem[] };
      this.items.clear();
      await this.upsert(parsed.items ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  override async upsert(items: readonly MainlineVectorItem[]): Promise<void> {
    await super.upsert(items);
    await this.#save();
  }

  override async remove(ids: readonly string[]): Promise<void> {
    await super.remove(ids);
    await this.#save();
  }

  async #save(): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    const payload = JSON.stringify({ items: await this.snapshot() }, null, 2);
    await fs.writeFile(this.#filePath, `${payload}\n`, "utf8");
  }
}

/**
 * 显式 no-op 实现保留给未配置 embedding 的宿主使用。
 * 它不会伪装成可用向量库；调用方需要从 embedding report 判断增强是否生效。
 */
export class NoopMainlineVectorStore implements MainlineVectorStore {
  async upsert(_items: readonly MainlineVectorItem[]): Promise<void> {}

  async remove(_ids: readonly string[]): Promise<void> {}

  async search(
    _vector: readonly number[],
    _options: MainlineVectorSearchOptions = {},
  ): Promise<MainlineVectorSearchHit[]> {
    return [];
  }

  async get(_id: string): Promise<MainlineVectorItem | undefined> {
    return undefined;
  }

  async snapshot(): Promise<MainlineVectorItem[]> {
    return [];
  }
}

function normalizeVectorItem(item: MainlineVectorItem): MainlineVectorItem {
  return {
    id: item.id,
    vector: [...item.vector],
    ...(item.content === undefined ? {} : { content: item.content }),
    ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
  };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index++) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
    leftNorm += (left[index] ?? 0) * (left[index] ?? 0);
    rightNorm += (right[index] ?? 0) * (right[index] ?? 0);
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function matchesMetadataFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter) {
    return true;
  }
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}
