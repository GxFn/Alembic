import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

const scanDefaults = {
  skills: ['code_analysis'],
  policies: [
    {
      type: 'budget' as const,
      maxIterations: 30,
      maxTokens: 8192,
      temperature: 0.3,
      timeoutMs: 3_600_000,
    },
  ],
  memory: { enabled: false },
  actionSpace: { mode: 'none' as const },
};

export const SCAN_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'scan-extract',
    title: 'Scan Extract',
    serviceKind: 'knowledge-production',
    lifecycle: 'active',
    basePreset: 'insight',
    defaults: scanDefaults,
    strategy: { type: 'pipeline', factory: 'scanPipeline' },
    projection: 'scan-recipes',
  },
  {
    id: 'scan-summarize',
    title: 'Scan Summarize',
    serviceKind: 'knowledge-production',
    lifecycle: 'active',
    basePreset: 'insight',
    defaults: scanDefaults,
    strategy: { type: 'pipeline', factory: 'scanPipeline' },
    projection: 'scan-recipes',
  },
];
