import { describe, expect, test, vi } from 'vitest';
import type { AgentMessage } from '../../lib/agent/AgentMessage.js';
import { type AgentRunInput, AgentService } from '../../lib/agent/service/index.js';

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    profile: { preset: 'chat' },
    message: {
      content: 'hello',
      history: [{ role: 'user', content: 'previous' }],
      metadata: { mode: 'remote-exec', lang: 'zh-CN' },
      sessionId: 's1',
    },
    context: {
      source: 'http-chat',
      lang: 'zh-CN',
      actor: { user: 'u1', role: 'developer', sessionId: 's1' },
    },
    ...overrides,
  };
}

describe('AgentService', () => {
  test('resolves profile from AgentRunInput and executes a runtime', async () => {
    const execute = vi.fn().mockResolvedValue({
      reply: 'ok',
      toolCalls: [{ tool: 'search_knowledge', args: {}, result: 'hit', durationMs: 1 }],
      tokenUsage: { input: 3, output: 5 },
      iterations: 2,
      durationMs: 7,
    });
    const build = vi.fn().mockReturnValue({ id: 'runtime-1', execute });
    const service = new AgentService({ runtimeBuilder: { build } });

    const result = await service.run(makeInput());

    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat', basePreset: 'chat', kind: 'compiled-agent-profile' }),
      expect.objectContaining({ lang: 'zh-CN' })
    );
    expect(execute).toHaveBeenCalled();
    expect(result).toMatchObject({
      runId: 'runtime-1',
      profileId: 'chat',
      reply: 'ok',
      status: 'success',
      usage: { inputTokens: 3, outputTokens: 5, iterations: 2, durationMs: 7 },
    });
  });

  test('does not allow message metadata to select the runtime profile', async () => {
    let capturedMessage: AgentMessage | null = null;
    const execute = vi.fn().mockImplementation(async (message: AgentMessage) => {
      capturedMessage = message;
      return {
        reply: 'ok',
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        iterations: 0,
        durationMs: 0,
      };
    });
    const build = vi.fn().mockReturnValue({ id: 'runtime-1', execute });
    const service = new AgentService({ runtimeBuilder: { build } });

    await service.run(makeInput());

    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat', basePreset: 'chat', kind: 'compiled-agent-profile' }),
      expect.any(Object)
    );
    expect(capturedMessage?.metadata).not.toHaveProperty('mode');
    expect(capturedMessage?.metadata).not.toHaveProperty('preset');
    expect(capturedMessage?.metadata).not.toHaveProperty('profile');
  });

  test('coordinates bootstrap-session through child AgentService runs', async () => {
    const execute = vi.fn().mockResolvedValue({
      reply: 'child-ok',
      toolCalls: [],
      tokenUsage: { input: 1, output: 1 },
      iterations: 1,
      durationMs: 1,
    });
    const build = vi.fn((profile: { id: string }) => ({ id: `${profile.id}:runtime`, execute }));
    const service = new AgentService({ runtimeBuilder: { build } });

    const result = await service.run({
      profile: { id: 'bootstrap-session' },
      params: {
        dimensions: [
          {
            id: 'overview',
            tier: 0,
            params: { needsCandidates: true, hasExistingRecipes: false, prescreenDone: false },
          },
          {
            id: 'api',
            tier: 1,
            params: { needsCandidates: false, hasExistingRecipes: false, prescreenDone: false },
          },
        ],
      },
      message: { role: 'internal', content: 'Bootstrap session', sessionId: 's1' },
      context: { source: 'bootstrap', runtimeSource: 'system' },
    });

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bootstrap-dimension' }),
      expect.any(Object)
    );
    expect(result).toMatchObject({
      profileId: 'bootstrap-session',
      reply: 'child-ok\n\nchild-ok',
      phases: {
        dimensionResults: {
          overview: { profileId: 'bootstrap-dimension' },
          api: { profileId: 'bootstrap-dimension' },
        },
      },
    });
  });
});
