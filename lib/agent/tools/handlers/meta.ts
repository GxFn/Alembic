import type { ToolDefinition, ToolHandler } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

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

export const metaPlanHandler: ToolHandler = async (invocation, context) => {
  if (!isRecord(invocation.input)) {
    return toolFailure(context.descriptor, "error", {
      code: "invalid_input",
      message: "meta.plan input must be an object.",
    });
  }
  const strategy = stringValue(invocation.input.strategy);
  const steps = Array.isArray(invocation.input.steps) ? invocation.input.steps : null;
  if (!strategy || !steps) {
    return toolFailure(context.descriptor, "error", {
      code: "invalid_input",
      message: "meta.plan requires strategy and steps.",
    });
  }
  const saved = await context.dependencies.memoryStore?.save({
    key: `plan:${context.dependencies.now?.() ?? Date.now()}`,
    content: JSON.stringify({ strategy, steps }),
    tags: ["plan"],
    category: "meta-plan",
  });
  return toolSuccess(context.descriptor, {
    accepted: true,
    strategy,
    stepCount: steps.length,
    steps,
    ...(saved ? { memoryKey: saved.key } : {}),
  });
};

export const metaReviewHandler: ToolHandler = async (_invocation, context) => {
  const tools = context.registry.list();
  const policyRequired = tools.filter((tool) => tool.availability.status === "policy_required");
  const unavailable = tools.filter((tool) => tool.availability.status === "unavailable");
  const writeLike = tools.filter((tool) => tool.risk === "write" || tool.risk === "side-effect");
  const [submissions, plans] = context.dependencies.memoryStore
    ? await Promise.all([
        context.dependencies.memoryStore.recall({ tags: ["submission"], limit: 20 }),
        context.dependencies.memoryStore.recall({ tags: ["plan"], limit: 5 }),
      ])
    : [[], []];
  return toolSuccess(context.descriptor, {
    toolCount: tools.length,
    available: tools.filter((tool) => tool.availability.status === "available").length,
    policyRequired: policyRequired.map((tool) => tool.name),
    unavailable: unavailable.map((tool) => tool.name),
    writeLike: writeLike.map((tool) => tool.name),
    submissions: submissions.map((record) => ({ key: record.key, content: record.content })),
    plans: plans.map((record) => ({ key: record.key, content: record.content })),
    compatibility: "no-legacy-v1-v2",
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
