import type { ToolDefinition, ToolHandler } from "../types.js";
import { isRecord, toolSuccess } from "../types.js";

export const metaCapabilitiesHandler: ToolHandler = (invocation, context) => {
  const includeUnavailable = includeUnavailableTools(invocation.input);
  const tools = context.registry
    .list()
    .filter((tool) => includeUnavailable || tool.availability.status === "available");

  return toolSuccess(context.descriptor, {
    version: "tools.v1",
    compatibility: "no-legacy-v1-v2",
    resources: uniqueResources(tools),
    tools,
  });
};

function includeUnavailableTools(input: unknown): boolean {
  if (!isRecord(input) || input.includeUnavailable === undefined) {
    return true;
  }
  return input.includeUnavailable !== false;
}

function uniqueResources(tools: readonly ToolDefinition[]): string[] {
  return [...new Set(tools.map((tool) => tool.resource))].sort();
}
