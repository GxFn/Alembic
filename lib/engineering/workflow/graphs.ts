import { CallGraphAnalyzer } from "../code/analysis/index.js";
import { EngineeringCodeGraph } from "../code/graph.js";
import type { EngineeringCodeCallGraphEdge, EngineeringCodeDataFlowEdge } from "../code/types.js";
import { EngineeringEntityGraph } from "../entity/graph.js";
import type {
  EngineeringDependencyGraph,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/types.js";
import { workflowDiagnostic } from "./core/core.js";
import { astSummariesFrom } from "./facts.js";
import type {
  EngineeringEntityGraphSnapshot,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowFactBundle,
  EngineeringWorkflowInput,
} from "./types.js";

export interface EngineeringWorkflowGraphBundle {
  readonly codeGraph: EngineeringCodeGraph;
  readonly callGraph: readonly EngineeringCodeCallGraphEdge[];
  readonly dataFlow: readonly EngineeringCodeDataFlowEdge[];
  readonly entityGraphSnapshot: EngineeringEntityGraphSnapshot;
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly partial: boolean;
}

export function buildGraphs(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
  facts: EngineeringWorkflowFactBundle,
): EngineeringWorkflowGraphBundle {
  const diagnostics: EngineeringWorkflowDiagnostic[] = [];
  let partial = false;
  const analysisInput = facts.astSummaries;
  let codeGraph = analysisInput
    ? EngineeringCodeGraph.fromAstSummary(analysisInput)
    : EngineeringCodeGraph.fromAstSummary([]);
  let callGraph: readonly EngineeringCodeCallGraphEdge[] = codeGraph.getCallGraphEdges();
  let dataFlow: readonly EngineeringCodeDataFlowEdge[] = codeGraph.getDataFlowEdges();

  if (analysisInput) {
    try {
      const explicitCallGraph = callGraph;
      const explicitDataFlow = dataFlow;
      const analysis = new CallGraphAnalyzer().analyze(analysisInput, {
        ...(input.pathHints === undefined ? {} : { pathHints: input.pathHints }),
      });
      codeGraph = EngineeringCodeGraph.fromAstSummary({
        astProjectSummary: { fileSummaries: astSummariesFrom(analysisInput) },
        // 中文说明：外部 adapter 可能已经注入成熟调用图；这里与增量推断结果合并，避免迁移期丢边。
        callGraphEdges: [...explicitCallGraph, ...analysis.callEdges],
        dataFlowEdges: [...explicitDataFlow, ...analysis.dataFlowEdges],
      });
      callGraph = codeGraph.getCallGraphEdges();
      dataFlow = codeGraph.getDataFlowEdges();
    } catch (error: unknown) {
      partial = true;
      diagnostics.push(
        workflowDiagnostic(
          "buildGraphs",
          "warning",
          "Call graph analysis failed; using structural code graph",
          error,
        ),
      );
    }
  }

  const entityGraph = EngineeringEntityGraph.fromInput({
    targets: discovery.targets,
    files: facts.files,
    dependencyGraph: discovery.dependencyGraph,
    codeGraph,
    callGraph,
    dataFlow,
  });

  return {
    codeGraph,
    callGraph,
    dataFlow,
    entityGraphSnapshot: snapshotEntityGraph(entityGraph),
    diagnostics,
    partial,
  };
}

export function buildEmptyGraphs(
  targets: readonly EngineeringTarget[],
  files: readonly EngineeringFile[],
  dependencyGraph: EngineeringDependencyGraph,
): EngineeringWorkflowGraphBundle {
  const codeGraph = EngineeringCodeGraph.fromAstSummary([]);
  const entityGraph = EngineeringEntityGraph.fromInput({
    targets,
    files,
    dependencyGraph,
    codeGraph,
    callGraph: [],
    dataFlow: [],
  });
  return {
    codeGraph,
    callGraph: [],
    dataFlow: [],
    entityGraphSnapshot: snapshotEntityGraph(entityGraph),
    diagnostics: [],
    partial: true,
  };
}

function snapshotEntityGraph(entityGraph: EngineeringEntityGraph): EngineeringEntityGraphSnapshot {
  return {
    entities: entityGraph.entities,
    edges: entityGraph.edges,
    topology: entityGraph.getTopology(),
  };
}
