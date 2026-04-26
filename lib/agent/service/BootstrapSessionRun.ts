import type {
  AgentRunContext,
  AgentRunExecutionOptions,
  AgentRunInput,
  AgentRunMessage,
  AgentRunPresentationOptions,
} from './AgentRunContracts.js';

export interface BootstrapSessionChildRunPlan {
  id: string;
  label?: string;
  tier?: number;
  input: AgentRunInput;
  lazyInputFactory?: (event: {
    plannedInput: AgentRunInput;
    parentInput: AgentRunInput;
  }) => AgentRunInput | Promise<AgentRunInput>;
}

export interface BuildBootstrapSessionRunInputOptions {
  sessionId: string;
  children: BootstrapSessionChildRunPlan[];
  params?: Record<string, unknown>;
  message?: Partial<AgentRunMessage>;
  context?: Partial<AgentRunContext>;
  execution?: AgentRunExecutionOptions;
  presentation?: AgentRunPresentationOptions;
}

export function buildBootstrapSessionRunInput({
  sessionId,
  children,
  params,
  message,
  context,
  execution,
  presentation,
}: BuildBootstrapSessionRunInputOptions): AgentRunInput {
  return {
    profile: { id: 'bootstrap-session' },
    params: {
      ...(params || {}),
      dimensions: children.map((child) => ({
        id: child.id,
        label: child.label || child.id,
        ...(child.tier !== undefined ? { tier: child.tier } : {}),
        params: child.input.params || {},
        message: child.input.message,
        metadata: child.input.message.metadata || {},
        promptContext: child.input.context.promptContext || {},
      })),
    },
    message: {
      role: message?.role || 'internal',
      content: message?.content || 'Bootstrap session',
      history: message?.history,
      metadata: {
        sessionId,
        phase: 'bootstrap-session',
        ...(message?.metadata || {}),
      },
      sessionId: message?.sessionId || sessionId,
    },
    context: {
      source: 'bootstrap',
      runtimeSource: 'system',
      lang: context?.lang || firstChildLang(children),
      ...(context || {}),
      childContexts: {
        ...(context?.childContexts || {}),
        ...Object.fromEntries(children.map((child) => [child.id, child.input.context])),
      },
      childInputFactories: {
        ...(context?.childInputFactories || {}),
        ...Object.fromEntries(
          children.flatMap((child) =>
            child.lazyInputFactory ? [[child.id, child.lazyInputFactory]] : []
          )
        ),
      },
    },
    execution: execution || children[0]?.input.execution,
    presentation: presentation ||
      children[0]?.input.presentation || { responseShape: 'system-task-result' },
  };
}

function firstChildLang(children: BootstrapSessionChildRunPlan[]) {
  return (
    children.find((child) => child.input.context.lang !== undefined)?.input.context.lang || null
  );
}
