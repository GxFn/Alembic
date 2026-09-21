import { createProvider } from '@alembic/agent/ai';
import { ExplorationTracker } from '@alembic/agent/context';
import { ActiveContext, MemoryCoordinator, SessionStore } from '@alembic/agent/memory';
import { AgentRuntime, BudgetController, MAX_TOOL_CALLS_PER_ITER } from '@alembic/agent/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as AiModule from '../../lib/injection/modules/AiModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

describe('Agent public surface smoke', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('connects the packaged LLM to host switching, usage storage and consumer invalidation', async () => {
    vi.stubEnv('ALEMBIC_EMBED_PROVIDER', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: body.model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      })
    );
    const container = new ServiceContainer();
    const record = vi.fn();
    container.register('tokenUsageStore', () => ({ record }));
    container.singleton('llmConsumer', (ct) => ct.singletons.aiProvider, { aiDependent: true });
    AiModule.register(container);
    const providers = ['gpt-5.5', 'gpt-4o'].map((model) =>
      createProvider({
        provider: 'openai',
        model,
        apiKey: 'fixture-key',
        baseUrl: 'https://fixture.invalid/v1',
        maxRetries: 0,
      })
    );
    let manager: unknown;
    for (const provider of providers) {
      container.reloadAiProvider(provider);
      manager ??= container.get('aiProviderManager');
      expect(container.get('aiProviderManager')).toBe(manager);
      expect(container.get('llmConsumer')).toBe(provider);
      expect(await provider.chat('hello')).toBe('done');
    }
    expect(
      record.mock.calls.map(([usage]) => ({ model: usage.model, inputTokens: usage.inputTokens }))
    ).toEqual([
      { model: 'gpt-5.5', inputTokens: 5 },
      { model: 'gpt-4o', inputTokens: 5 },
    ]);
    expect(container.singletons._embedProvider).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    // 宿主记录器失败交给 Manager 诊断，不能把已经成功的 LLM 响应改成失败或重发请求。
    record.mockImplementationOnce(() => {
      throw new Error('fixture storage failure');
    });
    expect(await providers[1].chat('still usable')).toBe('done');
    expect(record).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps runtime exports consumable without duplicating Agent loop tests', () => {
    expect(AgentRuntime).toBeDefined();
    expect(BudgetController).toBeDefined();
    expect(MAX_TOOL_CALLS_PER_ITER).toBeGreaterThan(0);
  });

  it('keeps memory and context contracts consumable from Alembic', () => {
    const memory = new MemoryCoordinator({ mode: 'bootstrap', totalMemoryBudget: 4000 });
    const active = new ActiveContext();
    const session = new SessionStore();
    const tracker = ExplorationTracker.resolve(
      { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      { reset: true }
    );

    active.startRound(1);
    active.setThought('smoke');
    active.endRound();

    expect(memory.getBudgetAllocation()).toMatchObject({
      activeContext: 1800,
      sessionStore: 1400,
    });
    expect(active.toJSON().rounds[0]?.thought).toBe('smoke');
    expect(session).toBeDefined();
    expect(tracker).toBeDefined();
  });
});
