import {
  type EngineeringGraphOverviewResult,
  type EngineeringGraphQueryInput,
  type EngineeringGraphQueryProvider,
  type EngineeringGraphQueryResult,
  EngineeringWorkflowGraphQueryProvider,
} from "../../engineering/index.js";
import type { MainlineEngineeringWorkflowArtifactStore } from "./EngineeringWorkflowArtifactStore.js";

export class MainlineEngineeringGraphProvider implements EngineeringGraphQueryProvider {
  readonly #store: MainlineEngineeringWorkflowArtifactStore;

  constructor(store: MainlineEngineeringWorkflowArtifactStore) {
    this.#store = store;
  }

  async overview(): Promise<EngineeringGraphOverviewResult> {
    return (await this.#readProvider()).overview();
  }

  async query(input: EngineeringGraphQueryInput): Promise<EngineeringGraphQueryResult> {
    return (await this.#readProvider()).query(input);
  }

  async #readProvider(): Promise<EngineeringWorkflowGraphQueryProvider> {
    const stored = await this.#store.load();
    if (!stored) {
      throw new Error("Engineering workflow artifact is unavailable.");
    }
    return new EngineeringWorkflowGraphQueryProvider({ artifact: stored.workflowArtifact });
  }
}
