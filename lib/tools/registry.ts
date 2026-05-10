import type { ToolDefinition, ToolName, ToolRegistryReader, ToolResource } from "./types.js";

const unavailableOutputSchema = {
  type: "object",
  properties: {
    error: { type: "object" },
  },
  additionalProperties: true,
} as const;

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "code.query",
    resource: "code",
    action: "query",
    title: "Code Query",
    description: "Queries compiled code facts once the code capability is wired.",
    availability: {
      status: "unavailable",
      reason: "Code resource is reserved for a future compiled-code fact provider.",
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
    outputSchema: unavailableOutputSchema,
    metadata: { stable: true },
  },
  {
    name: "terminal.execute",
    resource: "terminal",
    action: "execute",
    title: "Terminal Execute",
    description: "Declares terminal intent but never executes commands inside this tools module.",
    availability: {
      status: "policy_required",
      reason: "Terminal execution requires an external policy gate.",
    },
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    outputSchema: unavailableOutputSchema,
    metadata: { executesCommands: false },
  },
  {
    name: "knowledge.search",
    resource: "knowledge",
    action: "search",
    title: "Knowledge Search",
    description: "Searches compiled knowledge documents through mainline search and context ports.",
    availability: { status: "available" },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        text: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        symbols: { type: "array", items: { type: "string" } },
        kinds: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        includeContext: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        query: { type: "object" },
        hits: { type: "array", items: { type: "object" } },
        context: { type: "object" },
      },
      required: ["query", "hits", "context"],
      additionalProperties: false,
    },
    metadata: { port: "MainlineSearchIndex+ContextIndexReader" },
  },
  {
    name: "graph.query",
    resource: "graph",
    action: "query",
    title: "Graph Query",
    description: "Queries project intelligence graph facts through the mainline query port.",
    availability: { status: "available" },
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["callers", "callees", "impact", "dependencies", "cycles"],
        },
        ref: { type: "string" },
        maxDepth: { type: "integer", minimum: 0, maximum: 8, default: 1 },
        direction: { type: "string", enum: ["incoming", "outgoing", "both"], default: "both" },
        includeStart: { type: "boolean", default: false },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        operation: { type: "string" },
        result: { type: "array", items: { type: "object" } },
      },
      required: ["operation", "result"],
      additionalProperties: true,
    },
    metadata: { port: "MainlineProjectIntelligenceQueries" },
  },
  {
    name: "memory.query",
    resource: "memory",
    action: "query",
    title: "Memory Query",
    description: "Queries durable memory once the memory capability is wired.",
    availability: {
      status: "unavailable",
      reason: "Memory resource is intentionally not connected yet.",
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
    outputSchema: unavailableOutputSchema,
    metadata: { stable: true },
  },
  {
    name: "meta.capabilities",
    resource: "meta",
    action: "capabilities",
    title: "Tool Capabilities",
    description: "Returns this tools registry with availability and schema metadata.",
    availability: { status: "available" },
    inputSchema: {
      type: "object",
      properties: {
        includeUnavailable: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        version: { type: "string" },
        resources: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "object" } },
      },
      required: ["version", "resources", "tools"],
      additionalProperties: false,
    },
    metadata: { stable: true },
  },
] as const;

export class StaticToolRegistry implements ToolRegistryReader {
  readonly #definitionsByName: ReadonlyMap<string, ToolDefinition>;

  constructor(definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS) {
    this.#definitionsByName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    );
  }

  list(): ToolDefinition[] {
    return [...this.#definitionsByName.values()].map(cloneDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    const definition = this.#definitionsByName.get(name);
    return definition ? cloneDefinition(definition) : undefined;
  }

  listByResource(resource: ToolResource): ToolDefinition[] {
    return this.list().filter((definition) => definition.resource === resource);
  }
}

export function createDefaultToolRegistry(): StaticToolRegistry {
  return new StaticToolRegistry();
}

export function isRegisteredToolName(name: string): name is ToolName {
  return TOOL_DEFINITIONS.some((definition) => definition.name === name);
}

function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  return JSON.parse(JSON.stringify(definition)) as ToolDefinition;
}
