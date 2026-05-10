import {
  MainlineProjectIntelligenceQueries,
  type MainlineProjectIntelligenceTraversalDirection,
} from "../../../mainline/graph/index.js";
import type {
  ProjectIntelligenceArtifactProvider,
  ToolHandler,
  ToolResultEnvelope,
  ToolRuntimeDependencies,
} from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

type MainlineGraphOperation = "callers" | "callees" | "impact" | "dependencies" | "cycles";
type LegacyGraphOperation =
  | "class"
  | "protocol"
  | "hierarchy"
  | "overrides"
  | "extensions"
  | "search";
type GraphOperation = MainlineGraphOperation | LegacyGraphOperation;

const GRAPH_OPERATIONS = new Set<GraphOperation>([
  "callers",
  "callees",
  "impact",
  "dependencies",
  "cycles",
  "class",
  "protocol",
  "hierarchy",
  "overrides",
  "extensions",
  "search",
]);

const TRAVERSAL_DIRECTIONS = new Set<MainlineProjectIntelligenceTraversalDirection>([
  "incoming",
  "outgoing",
  "both",
]);

interface GraphQueryInput {
  readonly operation: GraphOperation;
  readonly ref?: string;
  readonly entity?: string;
  readonly maxDepth: number;
  readonly limit: number;
  readonly direction: MainlineProjectIntelligenceTraversalDirection;
  readonly includeStart: boolean;
}

export const graphOverviewHandler: ToolHandler = async (
  _invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const projectGraph = context.dependencies.projectGraph as ProjectGraphLike | undefined;
  if (projectGraph?.getOverview) {
    try {
      const overview = projectGraph.getOverview();
      if (overview) {
        return toolSuccess(context.descriptor, { source: "projectGraph", overview });
      }
    } catch {
      // Fall through to mainline artifact summary.
    }
  }

  const artifact = await loadProjectIntelligenceArtifact(
    context.dependencies.projectIntelligenceArtifactProvider,
  );
  if (!artifact && !context.dependencies.projectIntelligenceQueries) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "project_intelligence_unavailable",
      message: "graph.overview requires a ProjectIntelligence artifact provider.",
    });
  }

  if (!artifact) {
    return toolSuccess(context.descriptor, {
      projectRoot: null,
      files: { total: 0, parsed: 0, unsupported: 0, failed: 0 },
      symbols: { total: 0, byKind: {} },
      edges: { project: 0, semantic: 0 },
      note: "Only query port is available; inject an artifact provider for overview facts.",
    });
  }

  const fileStatuses = countBy(artifact.files.map((file) => file.status));
  const symbolKinds = countBy(artifact.symbols.map((symbol) => symbol.kind));
  return toolSuccess(context.descriptor, {
    ...(artifact.projectRoot ? { projectRoot: artifact.projectRoot } : {}),
    ...(artifact.generatedAt === undefined ? {} : { generatedAt: artifact.generatedAt }),
    files: {
      total: artifact.files.length,
      parsed: fileStatuses.parsed ?? 0,
      unsupported: fileStatuses.unsupported ?? 0,
      failed: fileStatuses.failed ?? 0,
    },
    languages: countBy(artifact.files.map((file) => file.languageId)),
    symbols: {
      total: artifact.symbols.length,
      byKind: symbolKinds,
    },
    edges: {
      project: artifact.projectGraph.edges.length,
      semantic: artifact.semanticEdges.length,
      callSites: artifact.callSites.length,
    },
  });
};

export const graphQueryHandler: ToolHandler = async (
  invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const parsed = parseGraphQueryInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const input = parsed.input;
  const result = isLegacyOperation(input.operation)
    ? runLegacyGraphQuery(context.dependencies, input)
    : runGraphQuery(await resolveProjectIntelligenceQueries(context.dependencies), input);
  if (!result.ok) {
    return toolFailure(context.descriptor, "error", result.error);
  }

  return toolSuccess(context.descriptor, {
    operation: input.operation,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.entity ? { entity: input.entity } : {}),
    result: result.data,
  });
};

function parseGraphQueryInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: GraphQueryInput }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query input must be an object." },
    };
  }

  const operation = optionalString(input.operation) ?? optionalString(input.type);
  if (!operation || !GRAPH_OPERATIONS.has(operation as GraphOperation)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query operation is required." },
    };
  }

  const direction = optionalString(input.direction) ?? "both";
  if (!TRAVERSAL_DIRECTIONS.has(direction as MainlineProjectIntelligenceTraversalDirection)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query direction is invalid." },
    };
  }

  const maxDepth = boundedInteger(input.maxDepth, 1, 8);
  if (maxDepth === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query maxDepth must be an integer." },
    };
  }

  const ref = optionalString(input.ref);
  const entity = optionalString(input.entity) ?? ref;
  const limit = boundedInteger(input.limit, 20, 100);
  if (limit === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query limit must be an integer." },
    };
  }

  return {
    ok: true,
    input: {
      operation: operation as GraphOperation,
      ...(ref ? { ref } : {}),
      ...(entity ? { entity } : {}),
      maxDepth,
      limit,
      direction: direction as MainlineProjectIntelligenceTraversalDirection,
      includeStart: input.includeStart === true,
    },
  };
}

async function resolveProjectIntelligenceQueries(
  dependencies: ToolRuntimeDependencies,
): Promise<MainlineProjectIntelligenceQueries | undefined> {
  if (dependencies.projectIntelligenceQueries) {
    return dependencies.projectIntelligenceQueries;
  }
  const artifact = await loadProjectIntelligenceArtifact(
    dependencies.projectIntelligenceArtifactProvider,
  );
  return artifact ? new MainlineProjectIntelligenceQueries(artifact) : undefined;
}

async function loadProjectIntelligenceArtifact(
  provider: ToolRuntimeDependencies["projectIntelligenceArtifactProvider"],
) {
  if (!provider) {
    return null;
  }
  if (typeof provider === "function") {
    return provider();
  }
  return (provider as ProjectIntelligenceArtifactProvider).load();
}

function runGraphQuery(
  queries: MainlineProjectIntelligenceQueries | undefined,
  input: GraphQueryInput,
):
  | { readonly ok: true; readonly data: readonly unknown[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!queries) {
    return {
      ok: false,
      error: {
        code: "project_intelligence_unavailable",
        message: "graph.query requires ProjectIntelligenceQueries or an artifact provider.",
      },
    };
  }

  if (
    (input.operation === "callers" ||
      input.operation === "callees" ||
      input.operation === "impact") &&
    !input.ref
  ) {
    return {
      ok: false,
      error: { code: "invalid_input", message: `${input.operation} requires ref.` },
    };
  }

  switch (input.operation) {
    case "callers":
      return { ok: true, data: queries.callers(input.ref ?? "") };
    case "callees":
      return { ok: true, data: queries.callees(input.ref ?? "") };
    case "impact":
      return {
        ok: true,
        data: queries.impactRadius(input.ref ?? "", {
          maxDepth: input.maxDepth,
          direction: input.direction,
          includeStart: input.includeStart,
        }),
      };
    case "dependencies":
      return { ok: true, data: queries.fileDependencyAdjacency(input.ref) };
    case "cycles":
      return { ok: true, data: queries.cycles(input.ref) };
    default:
      return {
        ok: false,
        error: { code: "invalid_input", message: "Unsupported graph query operation." },
      };
  }
}

function runLegacyGraphQuery(
  dependencies: ToolRuntimeDependencies,
  input: GraphQueryInput,
):
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const graph = dependencies.projectGraph as ProjectGraphLike | undefined;
  const entityGraph = dependencies.codeEntityGraph as CodeEntityGraphLike | undefined;
  const entity = input.entity;
  if (!graph && !entityGraph) {
    return {
      ok: false,
      error: {
        code: "graph_dependency_unavailable",
        message: "Legacy graph query types require projectGraph or codeEntityGraph dependency.",
      },
    };
  }
  if (!entity) {
    return {
      ok: false,
      error: { code: "invalid_input", message: `${input.operation} requires entity or ref.` },
    };
  }

  switch (input.operation) {
    case "class":
      return {
        ok: true,
        data: graph?.getClassInfo?.(entity) ?? entityGraph?.queryEntity?.(entity, "class") ?? null,
      };
    case "protocol":
      return { ok: true, data: graph?.getProtocolInfo?.(entity) ?? null };
    case "hierarchy":
      return { ok: true, data: graph?.getClassHierarchy?.(entity) ?? null };
    case "overrides":
      return { ok: true, data: graph?.getMethodOverrides?.(entity) ?? null };
    case "extensions":
      return { ok: true, data: graph?.getCategoryMap?.(entity) ?? null };
    case "search":
      return {
        ok: true,
        data:
          entityGraph?.search?.(entity, input.limit) ??
          graph?.searchEntities?.(entity, input.limit) ??
          null,
      };
    default:
      return {
        ok: false,
        error: { code: "invalid_input", message: "Unsupported legacy graph query." },
      };
  }
}

function isLegacyOperation(operation: GraphOperation): operation is LegacyGraphOperation {
  return (
    operation === "class" ||
    operation === "protocol" ||
    operation === "hierarchy" ||
    operation === "overrides" ||
    operation === "extensions" ||
    operation === "search"
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInteger(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return Math.min(value, max);
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

interface GraphOverview {
  readonly languages?: readonly string[];
  readonly totalFiles?: number;
  readonly totalDefinitions?: number;
  readonly summary?: Record<string, unknown>;
  readonly modules?: readonly unknown[];
}

interface ProjectGraphLike {
  getOverview?(): GraphOverview | null;
  getClassInfo?(name: string): unknown;
  getProtocolInfo?(name: string): unknown;
  getClassHierarchy?(name: string): unknown;
  getMethodOverrides?(name: string): unknown;
  getCategoryMap?(name: string): unknown;
  searchEntities?(query: string, limit: number): unknown;
}

interface CodeEntityGraphLike {
  queryEntity?(name: string, kind: string): unknown;
  search?(query: string, limit: number): unknown;
}
