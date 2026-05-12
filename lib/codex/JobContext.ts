import { CODEX_CHANNEL_ID } from '../shared/channel.js';

export const CODEX_JOB_CLIENT = 'codex-plugin';

export interface CodexJobContextInput {
  createdByTool: string;
  sessionId: string;
  user?: string;
}

export function createCodexJobContext(input: CodexJobContextInput) {
  return {
    actor: {
      role: 'external_agent',
      ...(input.user ? { user: input.user } : {}),
    },
    channelId: CODEX_CHANNEL_ID,
    client: CODEX_JOB_CLIENT,
    createdByTool: input.createdByTool,
    sessionId: input.sessionId,
  };
}
