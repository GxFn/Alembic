import { createDefaultDiscovererRegistry } from "../discovery/index.js";
import type {
  EngineeringDependencyGraph,
  EngineeringDiscoverer,
  EngineeringTarget,
} from "../foundation/types.js";
import { workflowDiagnostic } from "./core/core.js";
import type {
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowInput,
} from "./types.js";

const EMPTY_DEPENDENCY_GRAPH: EngineeringDependencyGraph = { nodes: [], edges: [] };

export function emptyDiscovery(): EngineeringWorkflowDiscoveryResult {
  return {
    targets: [],
    files: [],
    dependencyGraph: EMPTY_DEPENDENCY_GRAPH,
  };
}

export async function discoverProject(
  input: EngineeringWorkflowInput,
): Promise<EngineeringWorkflowDiscoveryResult> {
  if (input.discoveryResult) {
    return input.discoveryResult;
  }

  const discoverer =
    input.discoverer ?? (await createDefaultDiscovererRegistry().detect(input.projectRoot));
  await discoverer.load(input.projectRoot);
  const targets = await discoverer.listTargets();
  const diagnostics: EngineeringWorkflowDiagnostic[] = [];
  const files = [];
  const seen = new Set<string>();

  for (const target of targets) {
    try {
      const targetFiles = await discoverer.getTargetFiles(target);
      for (const file of targetFiles) {
        const key = file.relativePath || file.path;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        files.push(file);
      }
    } catch (error: unknown) {
      diagnostics.push(
        workflowDiagnostic(
          "discover",
          "warning",
          `Target file discovery failed for ${targetName(target)}`,
          error,
        ),
      );
    }
  }

  const dependencyGraph = await dependencyGraphFor(discoverer, diagnostics);
  return {
    targets,
    files,
    dependencyGraph,
    discovererId: discoverer.id,
    discovererName: discoverer.displayName,
    diagnostics,
  };
}

async function dependencyGraphFor(
  discoverer: EngineeringDiscoverer,
  diagnostics: EngineeringWorkflowDiagnostic[],
): Promise<EngineeringDependencyGraph> {
  try {
    return await discoverer.getDependencyGraph();
  } catch (error: unknown) {
    diagnostics.push(
      workflowDiagnostic("discover", "warning", "Dependency graph discovery failed", error),
    );
    return EMPTY_DEPENDENCY_GRAPH;
  }
}

function targetName(target: EngineeringTarget | string): string {
  return typeof target === "string" ? target : target.name;
}
