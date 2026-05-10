export interface MainlineZonedPath {
  readonly path: string;
  readonly zone?: string;
}

export interface MainlineAtomicFileStore {
  readText(target: MainlineZonedPath): Promise<string | null>;
  readJson<T>(target: MainlineZonedPath): Promise<T | null>;
  writeJsonAtomic(target: MainlineZonedPath, value: unknown): Promise<void>;
  appendJsonl(target: MainlineZonedPath, value: unknown): Promise<void>;
}

export interface MainlineJsonlReadOptions {
  readonly limit?: number;
}

export interface MainlineJsonlReadResult<T> {
  readonly entries: T[];
  readonly skippedCorruptLines: number;
}

/**
 * MainlineJsonDocumentStore 负责单个 JSON 文档。
 * 写入边界：调用方只能通过 MainlineAtomicFileStore 落盘，避免 data 层绕过原子写协议。
 */
export class MainlineJsonDocumentStore<T> {
  readonly #target: MainlineZonedPath;
  readonly #fileStore: MainlineAtomicFileStore;

  constructor(target: MainlineZonedPath, fileStore: MainlineAtomicFileStore) {
    this.#target = target;
    this.#fileStore = fileStore;
  }

  async load(): Promise<T | null> {
    return this.#fileStore.readJson<T>(this.#target);
  }

  async save(value: T): Promise<void> {
    await this.#fileStore.writeJsonAtomic(this.#target, value);
  }

  async update(mutator: (current: T | null) => T): Promise<T> {
    const next = mutator(await this.load());
    await this.save(next);
    return next;
  }
}

/**
 * MainlineJsonlLog 负责 append-only JSONL。
 * 写入边界：这里只追加结构化事件，坏行只影响读取结果并被计数跳过。
 */
export class MainlineJsonlLog<T> {
  readonly #target: MainlineZonedPath;
  readonly #fileStore: MainlineAtomicFileStore;

  constructor(target: MainlineZonedPath, fileStore: MainlineAtomicFileStore) {
    this.#target = target;
    this.#fileStore = fileStore;
  }

  async append(entry: T): Promise<void> {
    await this.#fileStore.appendJsonl(this.#target, entry);
  }

  async read(options: MainlineJsonlReadOptions = {}): Promise<MainlineJsonlReadResult<T>> {
    const raw = await this.#fileStore.readText(this.#target);
    if (raw === null) {
      return { entries: [], skippedCorruptLines: 0 };
    }

    const entries: T[] = [];
    let skippedCorruptLines = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        entries.push(JSON.parse(trimmed) as T);
      } catch {
        skippedCorruptLines += 1;
      }
    }

    return {
      entries: options.limit ? entries.slice(-options.limit) : entries,
      skippedCorruptLines,
    };
  }
}
