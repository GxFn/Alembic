import type { AgentRunInput } from '@alembic/agent/service';
import { describe, expect, test } from 'vitest';
import {
  buildGenerateSessionRunInput,
  type GenerateSessionChildRunPlan,
} from '../../lib/recipe-pipeline/generate/execution/AgentRunInputBuilders.js';

function makeChild(id: string, tier: number): GenerateSessionChildRunPlan {
  return {
    id,
    label: id.toUpperCase(),
    tier,
    input: {
      profile: { id: 'generate-dimension' },
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

describe('buildGenerateSessionRunInput', () => {
  test('builds a pure parent input from prepared child run inputs', () => {
    const lazyInputFactory = ({ plannedInput }: { plannedInput: AgentRunInput }) => plannedInput;
    const input = buildGenerateSessionRunInput({
      sessionId: 'session-1',
      children: [{ ...makeChild('overview', 0), lazyInputFactory }, makeChild('api', 1)],
      message: { content: 'Run bootstrap session' },
      context: {
        promptContext: { project: 'Alembic' },
      },
    });

    expect(input).toMatchObject({
      profile: { id: 'generate-session' },
      message: {
        role: 'internal',
        content: 'Run bootstrap session',
        sessionId: 'session-1',
        // wire:metadata.phase 是 process-event 持久化值(与 profile id 同拼写不同义),期望旧串
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
