import { describe, expect, test, vi } from 'vitest';
import { LarkTransport } from '../../lib/external/lark/LarkTransport.js';

describe('LarkTransport AgentService integration', () => {
  test('routes remote-exec prefix through AgentService.run', async () => {
    const run = vi.fn().mockResolvedValue({
      runId: 'run-1',
      profileId: 'remote-exec',
      reply: 'done',
      status: 'success',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, iterations: 1, durationMs: 1 },
      diagnostics: null,
    });
    const replies: string[] = [];
    const sends: string[] = [];
    const transport = new LarkTransport({
      agentService: { run } as never,
      aiProviderInfo: { getAiProviderInfo: () => ({ name: 'test-provider' }) },
      replyFn: async (_messageId: string, text: string) => {
        replies.push(text);
      },
      sendFn: async (text: string) => {
        sends.push(text);
        return true;
      },
      projectRoot: '/tmp',
    });

    await transport.receive({
      message: {
        message_id: 'msg-1',
        chat_id: 'chat-1',
        message_type: 'text',
        content: JSON.stringify({ text: '$git status' }),
      },
      sender: { sender_id: { user_id: 'user-1' } },
    });

    expect(replies[0]).toContain('正在执行');
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { preset: 'remote-exec' },
        message: expect.objectContaining({
          content: 'git status',
          sessionId: 'chat-1',
        }),
        context: expect.objectContaining({
          source: 'lark',
          actor: expect.objectContaining({ user: 'user-1' }),
        }),
      })
    );
    expect(sends).toContain('done');
  });
});
