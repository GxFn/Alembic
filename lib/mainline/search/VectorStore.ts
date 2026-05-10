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
 * 零依赖向量端口占位实现。
 * L3 纯 TS 阶段只定义边界，运行期没有配置向量库时保持 no-op，避免引入 native deps。
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
