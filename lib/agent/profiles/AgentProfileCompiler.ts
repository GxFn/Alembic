import { BudgetPolicy, type Policy, SafetyPolicy } from '../policies/index.js';
import type {
  AgentActionSpace,
  AgentConcurrencyPlan,
  AgentProfileDefinition,
  AgentProfileOverride,
  AgentProfileRef,
  AgentRunContext,
  AgentStrategyTemplate,
  CompiledAgentProfile,
} from '../service/AgentRunContracts.js';
import type { AgentProfileRegistry } from './AgentProfileRegistry.js';
import type { AgentStageFactoryRegistry } from './AgentStageFactoryRegistry.js';

interface AgentProfileCompilerOptions {
  profileRegistry: AgentProfileRegistry;
  stageFactoryRegistry: AgentStageFactoryRegistry;
}

interface CompileOptions {
  params?: Record<string, unknown>;
  context?: AgentRunContext;
}

export class AgentProfileCompiler {
  #profileRegistry: AgentProfileRegistry;
  #stageFactoryRegistry: AgentStageFactoryRegistry;

  constructor({ profileRegistry, stageFactoryRegistry }: AgentProfileCompilerOptions) {
    this.#profileRegistry = profileRegistry;
    this.#stageFactoryRegistry = stageFactoryRegistry;
  }

  compile(
    profileInput: AgentProfileRef | AgentProfileOverride | CompiledAgentProfile,
    options: CompileOptions = {}
  ): CompiledAgentProfile {
    if (isCompiledProfile(profileInput)) {
      return profileInput;
    }
    if ('basePreset' in profileInput) {
      return this.#compileOverride(profileInput, options);
    }
    return this.#compileRef(profileInput, options);
  }

  #compileRef(profileRef: AgentProfileRef, options: CompileOptions): CompiledAgentProfile {
    const profileId = profileRef.id || profileRef.preset || '';
    const params = mergeParams(options.params, profileRef.params);
    const definition = profileId ? this.#profileRegistry.get(profileId) : null;
    if (!definition) {
      const preset = profileRef.preset || profileRef.id;
      if (!preset) {
        throw new Error('AgentProfileRef requires id or preset');
      }
      return this.#compilePresetRef(String(preset), params);
    }
    return this.#compileDefinition(definition, params, options.context);
  }

  #compileOverride(
    profileOverride: AgentProfileOverride,
    options: CompileOptions
  ): CompiledAgentProfile {
    const params = mergeParams(options.params, profileOverride.params);
    const actionSpace = profileOverride.actionSpace || { mode: 'listed', toolIds: [] };
    const runtimeOverrides = stripUndefined({
      capabilities: profileOverride.skills,
      strategy: profileOverride.strategy,
      policies: compilePolicyDeclarations(profileOverride.policies),
      persona: profileOverride.persona,
      memory: profileOverride.memory,
    });
    return {
      kind: 'compiled-agent-profile',
      id: profileOverride.id || String(profileOverride.basePreset),
      title: profileOverride.id || String(profileOverride.basePreset),
      serviceKind: 'system-analysis',
      lifecycle: 'active',
      basePreset: profileOverride.basePreset,
      skills: profileOverride.skills,
      strategy: profileOverride.strategy,
      policies: runtimeOverrides.policies as unknown[] | undefined,
      persona: profileOverride.persona,
      memory: profileOverride.memory,
      actionSpace,
      additionalTools: additionalToolsFromActionSpace(actionSpace),
      params,
      runtimeOverrides,
    };
  }

  #compilePresetRef(preset: string, params: Record<string, unknown>): CompiledAgentProfile {
    return {
      kind: 'compiled-agent-profile',
      id: preset,
      title: preset,
      serviceKind: serviceKindForPreset(preset),
      lifecycle: 'active',
      basePreset: preset,
      actionSpace: { mode: 'listed', toolIds: [] },
      additionalTools: [],
      params,
      runtimeOverrides: {},
    };
  }

  #compileDefinition(
    definition: AgentProfileDefinition,
    inputParams: Record<string, unknown>,
    context?: AgentRunContext
  ): CompiledAgentProfile {
    const params = mergeParams(defaultParamsForProfile(definition.id), inputParams);
    const actionSpace = resolveActionSpace(definition, params);
    const strategy = compileStrategy(definition.strategy, {
      params,
      context: context as unknown as Record<string, unknown>,
      stageFactoryRegistry: this.#stageFactoryRegistry,
    });
    const policies = compilePolicyDeclarations(resolvePolicyDeclarations(definition, params));
    const runtimeOverrides = stripUndefined({
      capabilities: definition.defaults?.skills,
      strategy,
      policies,
      persona: definition.defaults?.persona,
      memory: definition.defaults?.memory,
    });
    return {
      kind: 'compiled-agent-profile',
      id: definition.id,
      title: definition.title,
      serviceKind: definition.serviceKind,
      lifecycle: definition.lifecycle,
      basePreset: definition.basePreset || definition.id,
      skills: definition.defaults?.skills,
      strategy,
      policies,
      persona: definition.defaults?.persona,
      memory: definition.defaults?.memory,
      actionSpace,
      additionalTools: additionalToolsFromActionSpace(actionSpace),
      params,
      projection: definition.projection,
      concurrency: resolveConcurrencyPlan(definition.concurrency, params),
      runtimeOverrides,
    };
  }
}

function compileStrategy(
  strategy: AgentProfileDefinition['strategy'],
  {
    params,
    context,
    stageFactoryRegistry,
  }: {
    params: Record<string, unknown>;
    context?: Record<string, unknown>;
    stageFactoryRegistry: AgentStageFactoryRegistry;
  }
) {
  if (!strategy || (isStrategyTemplate(strategy) && strategy.type === 'preset')) {
    return undefined;
  }
  if (isStrategyTemplate(strategy) && strategy.type === 'pipeline') {
    return {
      type: 'pipeline',
      maxRetries: 1,
      stages: stageFactoryRegistry.build(strategy.factory, { params, context }),
    };
  }
  if (isStrategyTemplate(strategy) && strategy.type === 'single') {
    return { type: 'single' };
  }
  if (isStrategyTemplate(strategy) && strategy.type === 'fanout') {
    return undefined;
  }
  return strategy as Record<string, unknown>;
}

function compilePolicyDeclarations(policies: unknown[] | undefined) {
  if (!policies) {
    return undefined;
  }
  return policies.map((policy) => {
    if (!isRecord(policy) || typeof policy.type !== 'string') {
      return policy;
    }
    if (policy.type === 'budget') {
      const { type: _type, ...config } = policy;
      return new BudgetPolicy(config);
    }
    if (policy.type === 'safety') {
      return new SafetyPolicy();
    }
    return policy as unknown as Policy;
  });
}

function additionalToolsFromActionSpace(actionSpace: AgentActionSpace) {
  if (actionSpace.mode !== 'listed') {
    return [];
  }
  return [...actionSpace.toolIds];
}

function resolveActionSpace(definition: AgentProfileDefinition, params: Record<string, unknown>) {
  if (definition.id === 'signal-analysis' && params.mode === 'auto') {
    return { mode: 'listed' as const, toolIds: ['suggest_skills', 'create_skill'] };
  }
  return definition.defaults?.actionSpace || { mode: 'listed' as const, toolIds: [] };
}

function resolvePolicyDeclarations(
  definition: AgentProfileDefinition,
  params: Record<string, unknown>
) {
  if (definition.id === 'evolution-audit') {
    const recipes = Array.isArray(params.recipes) ? params.recipes : [];
    return [
      {
        type: 'budget',
        maxIterations: Math.min(recipes.length * 4 + 10, 120),
        maxTokens: 8192,
        temperature: 0.3,
        timeoutMs: 600_000,
      },
    ];
  }
  return definition.defaults?.policies;
}

function resolveConcurrencyPlan(
  concurrency: AgentConcurrencyPlan | undefined,
  params: Record<string, unknown>
) {
  if (!concurrency) {
    return undefined;
  }
  const paramConcurrency = params.concurrency;
  if (
    typeof paramConcurrency !== 'number' ||
    !Number.isFinite(paramConcurrency) ||
    paramConcurrency <= 0
  ) {
    return concurrency;
  }
  return {
    ...concurrency,
    concurrency: Math.max(1, Math.floor(paramConcurrency)),
  };
}

function defaultParamsForProfile(profileId: string) {
  if (profileId === 'scan-summarize') {
    return { task: 'summarize' };
  }
  if (profileId === 'scan-extract') {
    return { task: 'extract' };
  }
  if (profileId === 'deep-scan') {
    return { task: 'deep-scan', comprehensive: true };
  }
  return {};
}

function mergeParams(...paramsList: Array<Record<string, unknown> | undefined>) {
  return Object.assign({}, ...paramsList.filter(Boolean));
}

function stripUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isCompiledProfile(value: unknown): value is CompiledAgentProfile {
  return isRecord(value) && value.kind === 'compiled-agent-profile';
}

function isStrategyTemplate(value: unknown): value is AgentStrategyTemplate {
  return isRecord(value) && typeof value.type === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function serviceKindForPreset(preset: string): CompiledAgentProfile['serviceKind'] {
  if (preset === 'remote-exec') {
    return 'remote-operation';
  }
  if (preset === 'chat' || preset === 'lark') {
    return 'conversation';
  }
  if (preset === 'evolution') {
    return 'system-analysis';
  }
  return 'knowledge-production';
}

export default AgentProfileCompiler;
