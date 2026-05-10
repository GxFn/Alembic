import type { MainlineAtomicFileStore, MainlineZonedPath } from "../data/JsonStores.js";
import { MainlineJsonDocumentStore } from "../data/JsonStores.js";
import type { MainlineSearchDocument } from "./SearchIndex.js";
import { InMemoryMainlineSearchIndex } from "./SearchIndex.js";

export interface MainlineSearchIndexSnapshot {
  readonly version: 1;
  readonly documents: readonly MainlineSearchDocument[];
  readonly updatedAt: number;
}

/**
 * SearchIndexStore 持久化的是已编译出的搜索快照。
 * 运行期 restore 只读 JSON snapshot，不能临时回扫 Markdown 或旧 repository。
 */
export class MainlineSearchIndexStore {
  readonly #document: MainlineJsonDocumentStore<MainlineSearchIndexSnapshot>;
  readonly #now: () => number;

  constructor(
    target: MainlineZonedPath,
    fileStore: MainlineAtomicFileStore,
    options: { now?: () => number } = {},
  ) {
    this.#document = new MainlineJsonDocumentStore(target, fileStore);
    this.#now = options.now ?? Date.now;
  }

  async loadSnapshot(): Promise<MainlineSearchIndexSnapshot | null> {
    return this.#document.load();
  }

  async saveDocuments(
    documents: readonly MainlineSearchDocument[],
  ): Promise<MainlineSearchIndexSnapshot> {
    const snapshot: MainlineSearchIndexSnapshot = {
      version: 1,
      documents: normalizeDocuments(documents),
      updatedAt: this.#now(),
    };
    await this.#document.save(snapshot);
    return snapshot;
  }

  async restoreIndex(): Promise<InMemoryMainlineSearchIndex> {
    const index = new InMemoryMainlineSearchIndex();
    const snapshot = await this.loadSnapshot();
    if (snapshot) {
      index.upsert(snapshot.documents);
    }
    return index;
  }
}

function normalizeDocuments(
  documents: readonly MainlineSearchDocument[],
): MainlineSearchDocument[] {
  const byId = new Map<string, MainlineSearchDocument>();
  for (const document of documents) {
    byId.set(document.id, document);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}
