import {
  MainlineProjectIntelligenceQueries,
  type MainlineProjectIntelligenceTraversalDirection,
} from "../../mainline/graph/index.js";
import type {
  ProjectIntelligenceArtifactProvider,
  ToolHandler,
  ToolResultEnvelope,
  ToolRuntimeDependencies,
} from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

type GraphOperation = "callers" | "callees" | "impact" | "dependencies" | "cycles";

const GRAPH_OPERATIONS = new Set<GraphOperation>([
  "callers",
  "callees",
  "impact",
  "dependencies",
  "cycles",
]);

const TRAVERSAL_DIRECTIONS = new Set<MainlineProjectIntelligenceTraversalDirection>([
  "incoming",
  "outgoing",
  "both",
]);

interface GraphQueryInput {
  readonly operation: GraphOperation;
  readonly ref?: string;
  readonly maxDepth: number;
  readonly direction: MainlineProjectIntelligenceTraversalDirection;
  readonly includeStart: boolean;
}

export const graphQueryHandler: ToolHandler = async (
  invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const parsed = parseGraphQueryInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const queries = await resolveProjectIntelligenceQueries(context.dependencies);
  if (!queries) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "project_intelligence_unavailable",
      message: "graph.query requires ProjectIntelligenceQueries or an artifact provider.",
    });
  }

  const input = parsed.input;
  const result = runGraphQuery(queries, input);
  if (!result.ok) {
    return toolFailure(context.descriptor, "error", result.error);
  }

  return toolSuccess(context.descriptor, {
    operation: input.operation,
    ...(input.ref ? { ref: input.ref } : {}),
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

  const operation = optionalString(input.operation);
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

  return {
    ok: true,
    input: {
      operation: operation as GraphOperation,
      ...(ref ? { ref } : {}),
      maxDepth,
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
  queries: MainlineProjectIntelligenceQueries,
  input: GraphQueryInput,
):
  | { readonly ok: true; readonly data: readonly unknown[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
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
  }
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
