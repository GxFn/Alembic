import { describe, expect, test } from 'vitest';
import {
  type BootstrapSessionChildRunPlan,
  buildBootstrapSessionRunInput,
} from '#workflows/capabilities/execution/internal-agent/BootstrapInputBuilders.js';
import type { AgentRunInput } from '../../lib/agent/service/index.js';

function makeChild(id: string, tier: number): BootstrapSessionChildRunPlan {
  return {
    id,
    label: id.toUpperCase(),
    tier,
    input: {
      profile: { id: 'bootstrap-dimension' },
      params: {
        dimId: id,
        needsCandidates: tier === 0,
        hasExistingRecipes: false,
        prescreenDone: false,
      },
      message: {
        role: 'internal',
        content: `Bootstrap dimension: ${id}`,
        sessionId: 'session-1',
        metadata: { dimension: id },
      },
      context: {
        source: 'bootstrap',
        runtimeSource: 'system',
        lang: 'ts',
        promptContext: { dimId: id, dimensionScopeId: `${id}:analyst` },
        fileCache: [{ name: `${id}.ts`, relativePath: `${id}.ts`, content: 'export {}' }],
      },
      execution: { toolChoiceOverride: 'auto' },
      presentation: { responseShape: 'system-task-result' },
    } satisfies AgentRunInput,
  };
}

describe('buildBootstrapSessionRunInput', () => {
  test('builds a pure parent input from prepared child run inputs', () => {
    const lazyInputFactory = ({ plannedInput }: { plannedInput: AgentRunInput }) => plannedInput;
    const input = buildBootstrapSessionRunInput({
      sessionId: 'session-1',
      children: [{ ...makeChild('overview', 0), lazyInputFactory }, makeChild('api', 1)],
      message: { content: 'Run bootstrap session' },
      context: {
        promptContext: { project: 'Alembic' },
      },
    });

    expect(input).toMatchObject({
      profile: { id: 'bootstrap-session' },
      message: {
        role: 'internal',
        content: 'Run bootstrap session',
        sessionId: 'session-1',
        metadata: { sessionId: 'session-1', phase: 'bootstrap-session' },
      },
      context: {
        source: 'bootstrap',
        runtimeSource: 'system',
        lang: 'ts',
        promptContext: { project: 'Alembic' },
      },
      presentation: { responseShape: 'system-task-result' },
    });
    expect(input.params?.dimensions).toEqual([
      expect.objectContaining({
        id: 'overview',
        label: 'OVERVIEW',
        tier: 0,
        params: expect.objectContaining({ dimId: 'overview', needsCandidates: true }),
      }),
      expect.objectContaining({
        id: 'api',
        label: 'API',
        tier: 1,
        params: expect.objectContaining({ dimId: 'api', needsCandidates: false }),
      }),
    ]);
    expect(input.context.childContexts?.overview).toMatchObject({
      promptContext: { dimId: 'overview', dimensionScopeId: 'overview:analyst' },
      fileCache: [{ name: 'overview.ts', relativePath: 'overview.ts', content: 'export {}' }],
    });
    expect(input.context.childContexts?.api).toMatchObject({
      promptContext: { dimId: 'api', dimensionScopeId: 'api:analyst' },
    });
    expect(input.context.childInputFactories?.overview).toBe(lazyInputFactory);
    expect(input.context.childInputFactories?.api).toBeUndefined();
  });
});
