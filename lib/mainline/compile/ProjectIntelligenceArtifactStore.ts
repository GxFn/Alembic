import type { MainlineAtomicFileStore, MainlineZonedPath } from "../data/JsonStores.js";
import { MainlineJsonDocumentStore } from "../data/JsonStores.js";
import type { MainlineProjectIntelligenceArtifact } from "../graph/index.js";

export const MAINLINE_PROJECT_INTELLIGENCE_ARTIFACT_STORE_PATH =
  "context/project-intelligence-artifact.json";

export interface MainlineProjectIntelligenceArtifactStore {
  load(): Promise<MainlineProjectIntelligenceArtifact | null>;
  save(artifact: MainlineProjectIntelligenceArtifact): Promise<void>;
}

/**
 * 内存 artifact store 服务同一进程内的增量扫描。
 * 它只缓存 ProjectIntelligence read model，不保存 Recipe、workflow 或旧 service 状态。
 */
export class InMemoryMainlineProjectIntelligenceArtifactStore
  implements MainlineProjectIntelligenceArtifactStore
{
  #artifact: MainlineProjectIntelligenceArtifact | null = null;

  async load(): Promise<MainlineProjectIntelligenceArtifact | null> {
    return this.#artifact ? cloneProjectIntelligenceArtifact(this.#artifact) : null;
  }

  async save(artifact: MainlineProjectIntelligenceArtifact): Promise<void> {
    this.#artifact = cloneProjectIntelligenceArtifact(artifact);
  }
}

/**
 * JSON artifact store 保存上一轮项目事实快照。
 * 这份文件属于编译期缓存，跨进程复用也必须经 data 层的原子 JSON store。
 */
export class JsonMainlineProjectIntelligenceArtifactStore
  implements MainlineProjectIntelligenceArtifactStore
{
  readonly #document: MainlineJsonDocumentStore<MainlineProjectIntelligenceArtifact>;

  constructor(target: MainlineZonedPath, fileStore: MainlineAtomicFileStore) {
    this.#document = new MainlineJsonDocumentStore(target, fileStore);
  }

  async load(): Promise<MainlineProjectIntelligenceArtifact | null> {
    const artifact = await this.#document.load();
    return artifact ? cloneProjectIntelligenceArtifact(artifact) : null;
  }

  async save(artifact: MainlineProjectIntelligenceArtifact): Promise<void> {
    await this.#document.save(cloneProjectIntelligenceArtifact(artifact));
  }
}

function cloneProjectIntelligenceArtifact(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineProjectIntelligenceArtifact {
  return JSON.parse(JSON.stringify(artifact)) as MainlineProjectIntelligenceArtifact;
}
