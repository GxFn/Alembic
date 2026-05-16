import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const SIGNAL_PROFILES: AgentProfileDefinition[] = [
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
];
