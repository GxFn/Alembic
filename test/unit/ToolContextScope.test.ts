import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallRequest } from '@alembic/agent';
import { AgentRuntime } from '@alembic/agent/runtime';
import { RuntimeCapabilityCatalog, ToolRouterAdapter } from '@alembic/agent/tools/runtime';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ToolContextFactory } from '../../lib/tools/ToolContextFactory.js';

describe('host tool resource scope', () => {
  let projectRoot: string;
  let factory: ToolContextFactory;
  let router: ToolRouterAdapter;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'tool-scope-'));
    await writeFile(join(projectRoot, 'sample.ts'), 'first\nsecond\nthird');
    factory = new ToolContextFactory({ container: { get: () => undefined }, projectRoot });
    router = new ToolRouterAdapter({ contextFactory: factory });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  function request(runId: string, viewId = 'analyze', revision = 0): ToolCallRequest {
    return {
      toolId: 'code',
      args: { action: 'read', params: { path: 'sample.ts' } },
      actor: { user: 'fixture', sessionId: 'conversation' },
      source: { kind: 'runtime', name: 'test' },
      surface: 'runtime',
      runtime: {
        agentId: 'reused-runtime',
        dimensionScopeId: 'dimension',
        resourceScope: { runId, viewId, revision },
      },
    };
  }

  test('reuses memory within a run and isolates other runs and legacy actors', () => {
    const first = factory.create(request('first'));
    first.sessionStore?.save('private', 'first run memory');
    first.searchCache?.set('query', 'first result');
    expect(factory.create(request('first')).sessionStore?.recall()).toHaveLength(1);
    const other = factory.create(request('second'));
    expect(other.sessionStore?.recall()).toEqual([]);
    expect(other.searchCache?.get('query')).toBeUndefined();
    const sameRun = request('first');
    for (const isolated of [
      { ...sameRun, actor: { ...sameRun.actor, sessionId: 'other-session' } },
      { ...sameRun, actor: { ...sameRun.actor, user: 'other-user' } },
      { ...sameRun, runtime: { ...sameRun.runtime, dimensionScopeId: 'other-dimension' } },
    ]) {
      expect(factory.create(isolated).sessionStore?.recall()).toEqual([]);
    }

    const legacy = request('unused');
    delete legacy.runtime?.resourceScope;
    first.sessionStore?.save('not-legacy', 'explicit run');
    factory.create(legacy).sessionStore?.save('legacy', 'one actor');
    expect(
      factory
        .create({ ...legacy, actor: { user: 'other', sessionId: 'conversation' } })
        .sessionStore?.recall()
    ).toEqual([]);
    const anonymous = { ...legacy, actor: {}, runtime: undefined };
    factory.create(anonymous).sessionStore?.save('anonymous', 'call-local');
    expect(factory.create(anonymous).sessionStore?.recall()).toEqual([]);
  });

  test('read history is local to each view and cannot authorize another run to overwrite', async () => {
    expect((await router.execute(request('first'))).text).toContain('1|first');
    expect((await router.execute(request('first'))).text).toContain('unchanged');
    expect((await router.execute(request('second'))).text).toContain('1|first');
    expect((await router.execute(request('first', 'produce'))).text).toContain('1|first');
    expect((await router.execute(request('first', 'analyze', 1))).text).toContain('1|first');

    const denied = await router.execute({
      ...request('unread'),
      args: { action: 'write', params: { path: 'sample.ts', content: 'replace' } },
    });
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain('was not read in this run');
    expect(await readFile(join(projectRoot, 'sample.ts'), 'utf8')).toBe('first\nsecond\nthird');
  });

  test('releases one view or run without clearing its live sibling', async () => {
    const first = factory.create(request('first'));
    const sibling = factory.create(request('second'));
    first.sessionStore?.save('first', 'keep across stages');
    sibling.sessionStore?.save('second', 'concurrent');
    await router.execute(request('first'));
    await router.releaseScope({ runId: 'first', viewId: 'analyze' });
    expect(factory.create(request('first', 'produce')).sessionStore?.recall()).toHaveLength(1);
    expect((await router.execute(request('first'))).text).toContain('1|first');
    await router.releaseScope({ runId: 'first' });
    expect(first.sessionStore?.recall()).toEqual([]);
    expect(factory.create(request('first')).sessionStore?.recall()).toEqual([]);
    expect(sibling.sessionStore?.recall()).toHaveLength(1);
  });

  test('the real Agent runtime reuses this host view and releases it at the public loop boundary', async () => {
    const create = vi.spyOn(factory, 'create');
    const release = vi.spyOn(factory, 'releaseScope');
    const catalog = new RuntimeCapabilityCatalog();
    let iteration = 0;
    const runtime = new AgentRuntime({
      aiProvider: {
        name: 'mock',
        chatWithTools: async () =>
          ++iteration <= 2
            ? {
                functionCalls: [
                  { id: `read-${iteration}`, name: 'code', args: request('unused').args },
                ],
              }
            : { text: 'done' },
      } as never,
      toolRegistry: catalog,
      toolRouter: router,
      container: { get: () => catalog },
      additionalTools: ['code'],
      projectRoot,
      // 本例直调公开 reactLoop；不替换策略、router 或宿主 factory。
      strategy: {
        name: 'unused',
        execute: async () => {
          throw new Error('Unexpected strategy');
        },
      },
    });
    const result = await runtime.reactLoop('read twice', { budgetOverride: { maxIterations: 3 } });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.envelope?.text).toContain('1|first');
    expect(result.toolCalls[1]?.envelope?.text).toContain('unchanged');
    const scope = create.mock.calls[0]?.[0].runtime?.resourceScope;
    expect(scope?.runId).toEqual(expect.any(String));
    expect(release).toHaveBeenCalledWith({ runId: scope?.runId, viewId: scope?.viewId });
    expect(release).toHaveBeenCalledWith({ runId: scope?.runId });
    expect(create.mock.results[0]?.value.deltaCache.get('sample.ts')).toBeUndefined();
  });
});
