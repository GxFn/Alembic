import type { ToolCallContext } from '#tools/core/ToolCallContext.js';
import type { ToolRouterContract } from '#tools/core/ToolContracts.js';

export interface WorkflowHandlerContext {
  toolCallContext: ToolCallContext;
  toolRouter?: ToolRouterContract | null;
}

export type WorkflowHandler = (
  params: Record<string, unknown>,
  context: WorkflowHandlerContext
) => Promise<unknown>;

export interface WorkflowDefinition {
  id: string;
  description: string;
  parameters?: Record<string, unknown>;
  handler: WorkflowHandler;
}

export class WorkflowRegistry {
  #workflows = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition) {
    if (!definition.id) {
      throw new Error('Workflow definition must have an id');
    }
    if (this.#workflows.has(definition.id)) {
      throw new Error(`Workflow '${definition.id}' already registered`);
    }
    this.#workflows.set(definition.id, {
      ...definition,
      parameters: definition.parameters || {},
    });
  }

  unregister(id: string) {
    return this.#workflows.delete(id);
  }

  get(id: string) {
    return this.#workflows.get(id) || null;
  }

  has(id: string) {
    return this.#workflows.has(id);
  }

  list() {
    return [...this.#workflows.values()];
  }
}

export default WorkflowRegistry;
