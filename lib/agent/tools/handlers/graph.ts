import type {
  EngineeringGraphQueryInput,
  EngineeringGraphQueryOperation,
  EngineeringGraphTraversalDirection,
} from "../../../engineering/index.js";
import type { ToolHandler, ToolResultEnvelope } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

const GRAPH_OPERATIONS = new Set<EngineeringGraphQueryOperation>([
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

const TRAVERSAL_DIRECTIONS = new Set<EngineeringGraphTraversalDirection>([
  "incoming",
  "outgoing",
  "both",
]);

export const graphOverviewHandler: ToolHandler = async (
  _invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const provider = context.dependencies.engineeringGraphProvider;
  if (!provider) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "engineering_graph_unavailable",
      message: "graph.overview requires engineeringGraphProvider.",
    });
  }

  try {
    return toolSuccess(context.descriptor, await provider.overview());
  } catch (error: unknown) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "engineering_graph_unavailable",
      message: errorMessage(error),
    });
  }
};

export const graphQueryHandler: ToolHandler = async (
  invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const parsed = parseGraphQueryInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const provider = context.dependencies.engineeringGraphProvider;
  if (!provider) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "engineering_graph_unavailable",
      message: "graph.query requires engineeringGraphProvider.",
    });
  }

  try {
    return toolSuccess(context.descriptor, await provider.query(parsed.input));
  } catch (error: unknown) {
    return toolFailure(context.descriptor, "error", {
      code: "engineering_graph_query_failed",
      message: errorMessage(error),
    });
  }
};

function parseGraphQueryInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: EngineeringGraphQueryInput }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query input must be an object." },
    };
  }

  const operation = optionalString(input.operation) ?? optionalString(input.type);
  if (!operation || !GRAPH_OPERATIONS.has(operation as EngineeringGraphQueryOperation)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query operation is required." },
    };
  }

  const direction = optionalString(input.direction) ?? "both";
  if (!TRAVERSAL_DIRECTIONS.has(direction as EngineeringGraphTraversalDirection)) {
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

  const limit = boundedInteger(input.limit, 20, 100);
  if (limit === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "graph.query limit must be an integer." },
    };
  }

  const ref = optionalString(input.ref);
  const entity = optionalString(input.entity) ?? ref;
  return {
    ok: true,
    input: {
      operation: operation as EngineeringGraphQueryOperation,
      ...(ref ? { ref } : {}),
      ...(entity ? { entity } : {}),
      maxDepth,
      limit,
      direction: direction as EngineeringGraphTraversalDirection,
      includeStart: input.includeStart === true,
    },
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
