import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const EVOLUTION_PROFILES: AgentProfileDefinition[] = [
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
];
