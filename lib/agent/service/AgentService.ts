import { randomUUID } from 'node:crypto';
import { AgentRunCoordinator } from '../coordination/AgentRunCoordinator.js';
import { AgentProfileCompiler } from '../profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../profiles/AgentStageFactoryRegistry.js';
import { AgentMessage, Channel } from '../runtime/AgentMessage.js';
import type {
  AgentProfileOverride,
  AgentProfileRef,
  AgentRunInput,
  AgentRunResult,
  AgentRunStatus,
  AgentRuntimeBuildOptions,
  AgentRuntimeLike,
  AgentRuntimeRunOptions,
  AgentRuntimeSource,
  CompiledAgentProfile,
} from './AgentRunContracts.js';
import type { AgentRuntimeBuilder } from './AgentRuntimeBuilder.js';

interface AgentRuntimeBuilderLike {
  build(
    profile: AgentRunInput['profile'] | CompiledAgentProfile,
    options?: AgentRuntimeBuildOptions
  ): AgentRuntimeLike;
}

export interface AgentServiceOptions {
  runtimeBuilder: AgentRuntimeBuilder | AgentRuntimeBuilderLike;
  profileCompiler?: AgentProfileCompiler;
  runCoordinator?: AgentRunCoordinator;
}

export class AgentService {
  #runtimeBuilder: AgentRuntimeBuilderLike;
  #profileCompiler: AgentProfileCompiler;
  #runCoordinator: AgentRunCoordinator;

  constructor({ runtimeBuilder, profileCompiler, runCoordinator }: AgentServiceOptions) {
    this.#runtimeBuilder = runtimeBuilder;
    this.#profileCompiler = profileCompiler || createDefaultProfileCompiler();
    this.#runCoordinator = runCoordinator || new AgentRunCoordinator();
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    validateRunInput(input);
    const compiledProfile = this.#profileCompiler.compile(input.profile, {
      params: input.params,
      context: input.context,
    });
    if (this.#runCoordinator.canCoordinate(compiledProfile)) {
      const coordinated = await this.#runCoordinator.run(input, compiledProfile, (childInput) =>
        this.run(childInput)
      );
      if (coordinated) {
        return coordinated;
      }
    }
    const runtime = this.#runtimeBuilder.build(compiledProfile, {
      lang: input.context.lang || null,
      onProgress: input.execution?.onProgress || null,
      onToolCall: input.execution?.onToolCall || null,
    });
    if (input.context.fileCache !== undefined) {
      runtime.setFileCache?.(input.context.fileCache);
    }
    const message = buildAgentMessage(input);
    try {
      const result = await runtime.execute(message, buildRuntimeOptions(input));
      return {
        runId: runtime.id || randomUUID(),
        profileId: compiledProfile.id,
        reply: result.reply || '',
        status: inferRunStatus(result.reply),
        phases: result.phases,
        toolCalls: result.toolCalls || [],
        usage: {
          inputTokens: result.tokenUsage?.input || 0,
          outputTokens: result.tokenUsage?.output || 0,
          iterations: result.iterations || 0,
          durationMs: result.durationMs || 0,
        },
        diagnostics: result.diagnostics || null,
      };
    } catch (err: unknown) {
      return {
        runId: runtime.id || randomUUID(),
        profileId: compiledProfile.id,
        reply: err instanceof Error ? err.message : String(err),
        status: inferErrorStatus(err),
        toolCalls: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          iterations: 0,
          durationMs: 0,
        },
        diagnostics: null,
      };
    }
  }
}

function validateRunInput(input: AgentRunInput) {
  if (!input.profile) {
    throw new Error('AgentRunInput.profile is required');
  }
  if (!input.message?.content) {
    throw new Error('AgentRunInput.message.content is required');
  }
  if (!input.context?.source) {
    throw new Error('AgentRunInput.context.source is required');
  }
}

function buildAgentMessage(input: AgentRunInput) {
  const metadataContext = getRecord(input.message.metadata?.context);
  const promptContext = {
    ...metadataContext,
    ...(input.context.promptContext || {}),
  };
  return new AgentMessage({
    content: input.message.content,
    channel: toChannel(input.context.source),
    session: {
      id: input.message.sessionId || input.context.actor?.sessionId || randomUUID(),
      history: input.message.history || [],
    },
    sender: {
      id: input.context.actor?.user || 'agent-runner',
      type:
        input.message.role === 'system' || input.message.role === 'internal' ? 'system' : 'user',
    },
    metadata: stripProfileSelectionMetadata({
      ...(input.message.metadata || {}),
      ...(Object.keys(promptContext).length > 0 ? { context: promptContext } : {}),
      source: input.context.source,
      stream: input.presentation?.stream || false,
    }),
  });
}

function buildRuntimeOptions(input: AgentRunInput): AgentRuntimeRunOptions {
  const systemRunContext = input.context.systemRunContext;
  const projectedScopeId =
    systemRunContext?.scopeId ||
    (typeof input.context.sharedState?._dimensionScopeId === 'string'
      ? input.context.sharedState._dimensionScopeId
      : undefined);
  return {
    abortSignal: input.execution?.abortSignal,
    diagnostics: input.execution?.diagnostics,
    strategyContext: input.context.strategyContext,
    systemRunContext: input.context.systemRunContext,
    budgetOverride: input.execution?.budgetOverride,
    toolChoiceOverride: input.execution?.toolChoiceOverride,
    contextWindow: input.context.contextWindow,
    trace: input.context.trace,
    memoryCoordinator: input.context.memoryCoordinator,
    sharedState: input.context.sharedState,
    context: {
      ...(input.context.promptContext || {}),
      ...(projectedScopeId ? { dimensionScopeId: projectedScopeId } : {}),
    },
    source: input.context.runtimeSource || runtimeSourceFor(input.context.source),
  };
}

function runtimeSourceFor(source: AgentRunInput['context']['source']): AgentRuntimeSource {
  if (source === 'lark') {
    return 'user';
  }
  if (source === 'http-chat' || source === 'http-stream') {
    return 'user';
  }
  if (source === 'mcp' || source === 'bootstrap' || source === 'system-workflow') {
    return 'system';
  }
  return 'system';
}

function stripProfileSelectionMetadata(metadata: Record<string, unknown>) {
  const { mode: _mode, preset: _preset, profile: _profile, ...rest } = metadata;
  return rest;
}

function toChannel(source: AgentRunInput['context']['source']) {
  if (source === 'lark') {
    return Channel.LARK;
  }
  if (source === 'mcp') {
    return Channel.MCP;
  }
  if (source === 'internal' || source === 'system-workflow' || source === 'bootstrap') {
    return Channel.INTERNAL;
  }
  return Channel.HTTP;
}

function inferRunStatus(reply: string): AgentRunStatus {
  return reply ? 'success' : 'error';
}

function inferErrorStatus(err: unknown): AgentRunStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(message)) {
    return 'timeout';
  }
  if (/abort/i.test(message)) {
    return 'aborted';
  }
  if (/forbidden|blocked|denied/i.test(message)) {
    return 'blocked';
  }
  return 'error';
}

function createDefaultProfileCompiler() {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry(),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export default AgentService;
