import type {
  EngineeringCodeGraphSnapshot,
  EngineeringEntityGraphSnapshot,
  EngineeringPanoramaSnapshot,
  EngineeringWorkflowArtifact,
  EngineeringWorkflowResult,
} from "../../engineering/index.js";
import type { MainlineAtomicFileStore, MainlineZonedPath } from "../data/JsonStores.js";
import { MainlineJsonDocumentStore } from "../data/JsonStores.js";

export const MAINLINE_ENGINEERING_WORKFLOW_ARTIFACT_STORE_PATH =
  "context/engineering-workflow-artifact.json";
export const MAINLINE_ENGINEERING_CODE_GRAPH_STORE_PATH = "context/engineering-code-graph.json";
export const MAINLINE_ENGINEERING_ENTITY_GRAPH_STORE_PATH = "context/engineering-entity-graph.json";
export const MAINLINE_ENGINEERING_PANORAMA_SNAPSHOT_STORE_PATH =
  "context/engineering-panorama-snapshot.json";

export interface MainlineEngineeringWorkflowStoredArtifacts {
  readonly workflowResult: EngineeringWorkflowResult;
  readonly workflowArtifact: EngineeringWorkflowArtifact;
  readonly codeGraph: EngineeringCodeGraphSnapshot;
  readonly entityGraph: EngineeringEntityGraphSnapshot;
  readonly panoramaSnapshot: EngineeringPanoramaSnapshot | null;
}

export interface MainlineEngineeringWorkflowArtifactStore {
  load(): Promise<MainlineEngineeringWorkflowStoredArtifacts | null>;
  save(result: EngineeringWorkflowResult): Promise<void>;
}

/**
 * 工程 workflow 旁路缓存，服务后续 agent tool adapter。
 * 中文说明：这些文件是 ProjectIntelligence 的工程视图投影，不反向修改旧 artifact schema。
 */
export class InMemoryMainlineEngineeringWorkflowArtifactStore
  implements MainlineEngineeringWorkflowArtifactStore
{
  #result: EngineeringWorkflowResult | null = null;

  async load(): Promise<MainlineEngineeringWorkflowStoredArtifacts | null> {
    if (!this.#result) {
      return null;
    }
    return storedArtifactsFromResult(cloneEngineeringWorkflowResult(this.#result));
  }

  async save(result: EngineeringWorkflowResult): Promise<void> {
    this.#result = cloneEngineeringWorkflowResult(result);
  }
}

export class JsonMainlineEngineeringWorkflowArtifactStore
  implements MainlineEngineeringWorkflowArtifactStore
{
  readonly #workflowResult: MainlineJsonDocumentStore<EngineeringWorkflowResult>;
  readonly #codeGraph: MainlineJsonDocumentStore<EngineeringCodeGraphSnapshot>;
  readonly #entityGraph: MainlineJsonDocumentStore<EngineeringEntityGraphSnapshot>;
  readonly #panoramaSnapshot: MainlineJsonDocumentStore<EngineeringPanoramaSnapshot | null>;

  constructor(
    targets: {
      readonly workflowResult: MainlineZonedPath;
      readonly codeGraph: MainlineZonedPath;
      readonly entityGraph: MainlineZonedPath;
      readonly panoramaSnapshot: MainlineZonedPath;
    },
    fileStore: MainlineAtomicFileStore,
  ) {
    this.#workflowResult = new MainlineJsonDocumentStore(targets.workflowResult, fileStore);
    this.#codeGraph = new MainlineJsonDocumentStore(targets.codeGraph, fileStore);
    this.#entityGraph = new MainlineJsonDocumentStore(targets.entityGraph, fileStore);
    this.#panoramaSnapshot = new MainlineJsonDocumentStore(targets.panoramaSnapshot, fileStore);
  }

  async load(): Promise<MainlineEngineeringWorkflowStoredArtifacts | null> {
    const workflowResult = await this.#workflowResult.load();
    if (!workflowResult) {
      return null;
    }
    const [codeGraph, entityGraph, panoramaSnapshot] = await Promise.all([
      this.#codeGraph.load(),
      this.#entityGraph.load(),
      this.#panoramaSnapshot.load(),
    ]);
    return {
      workflowResult: cloneEngineeringWorkflowResult(workflowResult),
      workflowArtifact: cloneEngineeringWorkflowArtifact(workflowResult.artifact),
      codeGraph: cloneJson(codeGraph ?? workflowResult.artifact.codeGraph),
      entityGraph: cloneJson(entityGraph ?? workflowResult.artifact.entityGraph),
      panoramaSnapshot: cloneJson(panoramaSnapshot ?? workflowResult.artifact.panoramaSnapshot),
    };
  }

  async save(result: EngineeringWorkflowResult): Promise<void> {
    const clonedResult = cloneEngineeringWorkflowResult(result);
    await Promise.all([
      this.#workflowResult.save(clonedResult),
      this.#codeGraph.save(clonedResult.artifact.codeGraph),
      this.#entityGraph.save(clonedResult.artifact.entityGraph),
      this.#panoramaSnapshot.save(clonedResult.artifact.panoramaSnapshot),
    ]);
  }
}

function storedArtifactsFromResult(
  workflowResult: EngineeringWorkflowResult,
): MainlineEngineeringWorkflowStoredArtifacts {
  return {
    workflowResult,
    workflowArtifact: cloneEngineeringWorkflowArtifact(workflowResult.artifact),
    codeGraph: cloneJson(workflowResult.artifact.codeGraph),
    entityGraph: cloneJson(workflowResult.artifact.entityGraph),
    panoramaSnapshot: cloneJson(workflowResult.artifact.panoramaSnapshot),
  };
}

function cloneEngineeringWorkflowResult(
  result: EngineeringWorkflowResult,
): EngineeringWorkflowResult {
  return cloneJson(result);
}

function cloneEngineeringWorkflowArtifact(
  artifact: EngineeringWorkflowArtifact,
): EngineeringWorkflowArtifact {
  return cloneJson(artifact);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
