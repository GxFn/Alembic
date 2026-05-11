/**
 * @module tools/v2/cache/SearchCache
 *
 * 搜索结果 LRU 缓存。避免同一会话中重复搜索相同 pattern。
 */

export interface SearchCacheEntry {
  result: unknown;
  createdAt: number;
}

export class SearchCache {
  readonly #cache = new Map<string, SearchCacheEntry>();
  readonly #maxEntries: number;

  constructor(maxEntries = 100) {
    this.#maxEntries = maxEntries;
  }

  /** 生成缓存 key: pattern + glob + regex flag 组合 */
  static makeKey(pattern: string, glob?: string, regex?: boolean): string {
    return `${pattern}|${glob ?? ''}|${regex ? 'r' : 'l'}`;
  }

  get(key: string): unknown | undefined {
    const entry = this.#cache.get(key);
    if (!entry) {
      return undefined;
    }
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.result;
  }

  set(key: string, result: unknown): void {
    this.#cache.delete(key);
    this.#cache.set(key, { result, createdAt: Date.now() });
    if (this.#cache.size > this.#maxEntries) {
      const firstKey = this.#cache.keys().next().value;
      if (firstKey !== undefined) {
        this.#cache.delete(firstKey);
      }
    }
  }

  has(key: string): boolean {
    return this.#cache.has(key);
  }

  clear(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }
}
