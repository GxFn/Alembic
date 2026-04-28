import { describe, expect, test } from 'vitest';
import {
  type BootstrapFileEntry,
  buildBootstrapDimensionRunInput,
} from '#workflows/bootstrap/agent-runs/BootstrapDimensionInputBuilder.js';
import type { MemoryCoordinator } from '../../lib/agent/memory/MemoryCoordinator.js';
import type { SystemRunContext } from '../../lib/agent/runtime/SystemRunContext.js';

function makeSystemRunContext(): SystemRunContext {
  const memoryCoordinator = { marker: 'memory' } as unknown as MemoryCoordinator;
  return {
    scopeId: 'overview:analyst',
    contextWindow: { marker: 'window' } as unknown as SystemRunContext['contextWindow'],
    tracker: null,
    trace: { marker: 'trace' } as unknown as SystemRunContext['trace'],
    activeContext: { marker: 'active' } as unknown as SystemRunContext['activeContext'],
    memoryCoordinator,
    sharedState: {
      _dimensionScopeId: 'overview:analyst',
      submittedTitles: new Set(),
    },
    source: 'system',
    outputType: 'analysis',
    dimId: 'overview',
    dimensionId: 'overview',
    dimensionLabel: 'Overview',
    projectLanguage: 'ts',
  };
}

describe('buildBootstrapDimensionRunInput', () => {
  test('builds a bootstrap-dimension AgentRunInput from runtime context', () => {
    const systemRunContext = makeSystemRunContext();
    const files: BootstrapFileEntry[] = [
      { name: 'a.ts', path: '/repo/a.ts', relativePath: 'a.ts', content: 'export const a = 1;' },
    ];
    const abortController = new AbortController();
    const input = buildBootstrapDimensionRunInput({
      dimId: 'overview',
      dimConfig: { label: 'Overview' },
      needsCandidates: true,
      hasExistingRecipes: false,
      prescreenDone: false,
      sessionId: 'session-1',
      primaryLang: 'ts',
      projectLang: 'javascript',
      allFiles: files,
      systemRunContext,
      strategyContext: { fromSystemRunContext: true },
      memoryCoordinator: systemRunContext.memoryCoordinator,
      sessionAbortSignal: abortController.signal,
    });

    expect(input).toMatchObject({
      profile: { id: 'bootstrap-dimension' },
      params: {
        dimId: 'overview',
        needsCandidates: true,
        hasExistingRecipes: false,
        prescreenDone: false,
      },
      message: {
        role: 'internal',
        content: 'Bootstrap dimension: Overview',
        sessionId: 'session-1',
        metadata: {
          sessionId: 'session-1',
          dimension: 'overview',
          phase: 'bootstrap',
        },
      },
      context: {
        source: 'bootstrap',
        runtimeSource: 'system',
        lang: 'ts',
        fileCache: files,
        systemRunContext,
        strategyContext: { fromSystemRunContext: true },
        contextWindow: systemRunContext.contextWindow,
        trace: systemRunContext.trace,
        memoryCoordinator: systemRunContext.memoryCoordinator,
        sharedState: systemRunContext.sharedState,
        promptContext: {
          dimensionScopeId: 'overview:analyst',
          dimId: 'overview',
          dimensionId: 'overview',
        },
      },
      presentation: { responseShape: 'system-task-result' },
    });
    expect(input.execution?.abortSignal).toBe(abortController.signal);
  });
});
