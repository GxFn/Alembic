import type { EngineeringCodeGraph } from "../code/graph.js";
import type { EngineeringDependencyGraph } from "../foundation/types.js";
import { EngineeringPanoramaService } from "../panorama/service.js";
import type { EngineeringWorkflowFactBundle, EngineeringWorkflowInput } from "./types.js";

export function buildPanorama(
  input: EngineeringWorkflowInput,
  facts: EngineeringWorkflowFactBundle,
  dependencyGraph: EngineeringDependencyGraph,
  codeGraph: EngineeringCodeGraph,
) {
  const service = input.panoramaService ?? new EngineeringPanoramaService();
  const recipeFacts = optionalRecipeFacts(input);
  return service.buildSnapshot({
    projectRoot: input.projectRoot,
    files: facts.files,
    dependencyGraph,
    codeGraph,
    importFacts: facts.importFacts,
    ...(recipeFacts === undefined ? {} : { recipeFacts }),
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    ...(input.computedAt === undefined ? {} : { computedAt: input.computedAt }),
    ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
    ...(input.stale === undefined ? {} : { stale: input.stale }),
  });
}

function optionalRecipeFacts(input: EngineeringWorkflowInput) {
  const optionalStage = input.optionalStage;
  if (!optionalStage || typeof optionalStage === "boolean") {
    return undefined;
  }
  return optionalStage.recipeFacts;
}
