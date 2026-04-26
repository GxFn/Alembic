import type { AgentProfileDefinition } from './AgentRunContracts.js';

const BUILTIN_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'chat-default',
    title: 'Default Chat',
    serviceKind: 'conversation',
    lifecycle: 'active',
    basePreset: 'chat',
    defaults: {
      actionSpace: { mode: 'listed', toolIds: [] },
    },
    strategy: { type: 'preset' },
    projection: 'chat-reply',
  },
  {
    id: 'lark-chat',
    title: 'Lark Chat',
    serviceKind: 'conversation',
    lifecycle: 'active',
    basePreset: 'lark',
    defaults: {
      actionSpace: { mode: 'listed', toolIds: [] },
    },
    strategy: { type: 'preset' },
    projection: 'chat-reply',
  },
  {
    id: 'remote-exec',
    title: 'Remote Exec',
    serviceKind: 'remote-operation',
    lifecycle: 'active',
    basePreset: 'remote-exec',
    defaults: {
      actionSpace: { mode: 'listed', toolIds: [] },
    },
    strategy: { type: 'preset' },
    projection: 'agent-result',
  },
  {
    id: 'scan-extract',
    title: 'Scan Extract',
    serviceKind: 'knowledge-production',
    lifecycle: 'active',
    basePreset: 'insight',
    defaults: {
      skills: ['code_analysis'],
      policies: [
        {
          type: 'budget',
          maxIterations: 30,
          maxTokens: 8192,
          temperature: 0.3,
          timeoutMs: 3_600_000,
        },
      ],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'scanPipeline' },
    projection: 'scan-recipes',
  },
  {
    id: 'scan-summarize',
    title: 'Scan Summarize',
    serviceKind: 'knowledge-production',
    lifecycle: 'active',
    basePreset: 'insight',
    defaults: {
      skills: ['code_analysis'],
      policies: [
        {
          type: 'budget',
          maxIterations: 30,
          maxTokens: 8192,
          temperature: 0.3,
          timeoutMs: 3_600_000,
        },
      ],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'scanPipeline' },
    projection: 'scan-recipes',
  },
  {
    id: 'relation-discovery',
    title: 'Relation Discovery',
    serviceKind: 'knowledge-production',
    lifecycle: 'active',
    basePreset: 'insight',
    defaults: {
      skills: ['knowledge_production', 'code_analysis'],
      policies: [
        {
          type: 'budget',
          maxIterations: 28,
          maxTokens: 8192,
          temperature: 0.3,
          timeoutMs: 420_000,
        },
      ],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'relationsPipeline' },
    projection: 'relation-discovery',
  },
  {
    id: 'evolution-audit',
    title: 'Evolution Audit',
    serviceKind: 'system-analysis',
    lifecycle: 'active',
    basePreset: 'evolution',
    defaults: {
      skills: ['evolution_analysis'],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'preset' },
    projection: 'evolution-audit',
  },
  {
    id: 'translation-json',
    title: 'Translation JSON',
    serviceKind: 'translation',
    lifecycle: 'active',
    basePreset: 'chat',
    defaults: {
      skills: [],
      policies: [
        { type: 'budget', maxIterations: 1, maxTokens: 4096, temperature: 0.2, timeoutMs: 120_000 },
      ],
      persona: {
        description: [
          '你是技术文档翻译专家。将中文技术内容翻译为地道的英文。保持技术术语不变。',
          '',
          '## 输出格式（必须是纯 JSON，不包含任何其他文字）',
          '{ "summaryEn": "...", "usageGuideEn": "..." }',
        ].join('\n'),
      },
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'single' },
    projection: 'json-object',
  },
  {
    id: 'signal-analysis',
    title: 'Signal Analysis',
    serviceKind: 'background-analysis',
    lifecycle: 'active',
    basePreset: 'chat',
    defaults: {
      skills: [],
      policies: [
        { type: 'budget', maxIterations: 8, maxTokens: 4096, temperature: 0.4, timeoutMs: 120_000 },
      ],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'single' },
    projection: 'agent-result',
  },
  {
    id: 'bootstrap-session',
    title: 'Bootstrap Session',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
    },
    strategy: {
      type: 'fanout',
      childProfile: 'bootstrap-dimension',
      partitioner: 'bootstrapSessionDimensions',
      merge: 'bootstrapSessionResults',
    },
    concurrency: {
      mode: 'tiered',
      concurrency: { env: 'ALEMBIC_BOOTSTRAP_CONCURRENCY', default: 2 },
      partitioner: 'bootstrapSessionDimensions',
      childProfile: 'bootstrap-dimension',
      merge: 'bootstrapSessionResults',
      abortPolicy: 'finish-tier',
    },
    projection: 'agent-result',
  },
  {
    id: 'bootstrap-dimension',
    title: 'Bootstrap Dimension',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'bootstrapDimensionPipeline' },
    projection: 'agent-result',
  },
];

export class AgentProfileRegistry {
  #profiles = new Map<string, AgentProfileDefinition>();

  constructor(profiles: AgentProfileDefinition[] = BUILTIN_PROFILES) {
    for (const profile of profiles) {
      this.register(profile);
    }
  }

  register(profile: AgentProfileDefinition) {
    if (!profile.id) {
      throw new Error('Agent profile id is required');
    }
    assertSerializableProfile(profile);
    this.#profiles.set(profile.id, profile);
    return this;
  }

  get(id: string) {
    return this.#profiles.get(id) || null;
  }

  require(id: string) {
    const profile = this.get(id);
    if (!profile) {
      throw new Error(`Unknown agent profile: "${id}"`);
    }
    return profile;
  }

  list() {
    return [...this.#profiles.values()];
  }
}

function assertSerializableProfile(profile: AgentProfileDefinition) {
  JSON.stringify(profile, (_key, value) => {
    if (typeof value === 'function') {
      throw new Error(`Agent profile "${profile.id}" must not contain functions`);
    }
    if (value instanceof Set || value instanceof Map) {
      throw new Error(`Agent profile "${profile.id}" must not contain Set or Map`);
    }
    return value;
  });
}

export default AgentProfileRegistry;
