import type { EngineeringWorkflowGraphBundle } from "./graphs.js";
import type {
  EngineeringWorkflowArtifact,
  EngineeringWorkflowCapabilities,
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowInput,
} from "./types.js";

export function workflowCapabilities(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
  graphs: EngineeringWorkflowGraphBundle,
  hasPanorama: boolean,
  optionalStage: EngineeringWorkflowArtifact["optionalStage"],
): EngineeringWorkflowCapabilities {
  return {
    injectedDiscovery: input.discoveryResult !== undefined,
    injectedAstSummaries: input.astSummaries !== undefined,
    injectedFileContents: input.fileContents !== undefined,
    injectedImportFacts: input.importFacts !== undefined,
    discovery: discovery.targets.length > 0 || discovery.files.length > 0,
    factCollection: true,
    codeGraph: graphs.codeGraph.toJSON().files.length > 0,
    callGraph: graphs.callGraph.length > 0,
    dataFlow: graphs.dataFlow.length > 0,
    entityGraph: graphs.entityGraphSnapshot.entities.length > 0,
    panorama: hasPanorama,
    optionalStage: optionalStage.status !== "disabled" && optionalStage.status !== "skipped",
    dimensionFileRefs: optionalStage.dimensionFileRefs.length > 0,
    cache: input.snapshotStore !== undefined,
    incrementalStore: input.snapshotStore !== undefined,
  };
}
