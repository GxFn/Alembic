import Logger from '#infra/logging/Logger.js';
import type { ToolRegistry } from '#tools/catalog/ToolRegistry.js';
import { CapabilityRegistry } from '../capabilities/index.js';
import { type Policy, PolicyEngine } from '../policies/index.js';
import { getPreset } from '../profiles/presets.js';
import { AgentRuntime } from '../runtime/AgentRuntime.js';
import type { Strategy } from '../strategies/index.js';
import type {
  AgentProfileOverride,
  AgentProfileRef,
  AgentRuntimeBuildOptions,
  CompiledAgentProfile,
} from './AgentRunContracts.js';

interface AgentRuntimeBuilderOptions {
  container: Record<string, unknown>;
  toolRegistry: ToolRegistry;
  aiProvider: unknown;
  memoryCoordinator?: unknown;
  projectBriefing?: string | null;
  projectRoot?: string;
}

export class AgentRuntimeBuilder {
  #container: Record<string, unknown>;
  #toolRegistry: ToolRegistry;
  #aiProvider: unknown;
  #logger = Logger.getInstance();
  #sharedOpts: {
    memoryCoordinator: unknown;
    projectBriefing: string | null;
    projectRoot: string;
  };

  constructor({
    container,
    toolRegistry,
    aiProvider,
    memoryCoordinator = null,
    projectBriefing = null,
    projectRoot = process.cwd(),
  }: AgentRuntimeBuilderOptions) {
    this.#container = container;
    this.#toolRegistry = toolRegistry;
    this.#aiProvider = aiProvider;
    this.#sharedOpts = {
      memoryCoordinator,
      projectBriefing,
      projectRoot,
    };
  }

  build(
    profileRef: AgentProfileRef | AgentProfileOverride | CompiledAgentProfile,
    options: AgentRuntimeBuildOptions = {}
  ) {
    const { presetName, overrides } = normalizeProfile(profileRef);
    const preset = getPreset(presetName, overrides as Record<string, unknown>);
    const capabilities = ((preset.capabilities as string[]) || []).map((name) =>
      CapabilityRegistry.create(name, this.#getCapabilityOpts(name))
    );
    const resolvedPolicies = (
      (preset.policies || []) as Array<Policy | ((input: Record<string, unknown>) => Policy)>
    ).map((policyOrFactory) =>
      typeof policyOrFactory === 'function'
        ? policyOrFactory(overrides as Record<string, unknown>)
        : policyOrFactory
    );

    this.#logger.debug('[AgentRuntimeBuilder] building runtime', { presetName });
    return new AgentRuntime({
      presetName,
      aiProvider: this.#aiProvider as never,
      toolRegistry: this.#toolRegistry,
      toolRouter: this.#toolRegistry.getRouter?.() || null,
      container: this.#container,
      capabilities,
      strategy: preset.strategyInstance as Strategy,
      policies: new PolicyEngine(resolvedPolicies),
      persona: preset.persona as Record<string, unknown> | undefined,
      memory: preset.memory as Record<string, unknown> | undefined,
      onProgress: options.onProgress || null,
      onToolCall: options.onToolCall || null,
      lang: options.lang || null,
      additionalTools: resolveActionSpaceAdditionalTools(profileRef),
      projectRoot: this.#sharedOpts.projectRoot,
    });
  }

  #getCapabilityOpts(name: string) {
    return {
      container: this.#container,
      memoryCoordinator: this.#sharedOpts.memoryCoordinator,
      projectBriefing: this.#sharedOpts.projectBriefing,
      projectRoot: this.#sharedOpts.projectRoot,
      ...(name === 'system_interaction' ? { projectRoot: this.#sharedOpts.projectRoot } : {}),
    };
  }
}

function normalizeProfile(profile: AgentProfileRef | AgentProfileOverride | CompiledAgentProfile) {
  if ('kind' in profile && profile.kind === 'compiled-agent-profile') {
    return { presetName: profile.basePreset, overrides: profile.runtimeOverrides || {} };
  }
  if (isProfileRef(profile)) {
    return { presetName: profile.preset || profile.id || 'chat', overrides: {} };
  }
  const { basePreset, skills, actionSpace, ...rest } = profile;
  return {
    presetName: basePreset,
    overrides: {
      ...rest,
      ...(skills ? { capabilities: skills } : {}),
      ...(actionSpace?.mode === 'listed' ? { additionalTools: actionSpace.toolIds } : {}),
    },
  };
}

function resolveActionSpaceAdditionalTools(
  profile: AgentProfileRef | AgentProfileOverride | CompiledAgentProfile
) {
  if ('kind' in profile && profile.kind === 'compiled-agent-profile') {
    return profile.additionalTools || [];
  }
  if (isProfileRef(profile) || profile.actionSpace?.mode !== 'listed') {
    return [];
  }
  return profile.actionSpace.toolIds;
}

function isProfileRef(
  profile: AgentProfileRef | AgentProfileOverride | CompiledAgentProfile
): profile is AgentProfileRef {
  return !('basePreset' in profile) && !('kind' in profile);
}

export default AgentRuntimeBuilder;
