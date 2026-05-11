import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const RELATION_PROFILES: AgentProfileDefinition[] = [
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
];
