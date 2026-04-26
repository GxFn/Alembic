import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const BOOTSTRAP_PROFILES: AgentProfileDefinition[] = [
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
