import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const REMOTE_PROFILES: AgentProfileDefinition[] = [
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
];
