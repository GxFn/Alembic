import type { MemoryCoordinator } from '@alembic/agent/memory';
import type { SystemRunContext } from '@alembic/agent/runtime';
import { describe, expect, test } from 'vitest';
import {
  buildGenerateDimensionRunInput,
  type GenerateFileEntry,
} from '../../lib/workflows/ai-execution/AgentRunInputBuilders.js';

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

describe('buildGenerateDimensionRunInput', () => {
  test('builds a bootstrap-dimension AgentRunInput from runtime context', () => {
    const systemRunContext = makeSystemRunContext();
    const files: GenerateFileEntry[] = [
      { name: 'a.ts', path: '/repo/a.ts', relativePath: 'a.ts', content: 'export const a = 1;' },
    ];
    const abortController = new AbortController();
    const input = buildGenerateDimensionRunInput({
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
      profile: { id: 'generate-dimension' },
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
    expect(input.message.metadata?.context).toMatchObject({
      pcvStageNodeMap: {
        analyze: {
          pcvNodeId: 'pcvm:n9:analyze',
          chainNodeId: 'pcvm:cold-start:n9',
        },
      },
      pcvChainNodes: {
        quality_gate: {
          pcvNodeId: 'pcvm:n9:quality_gate',
          chainNodeId: 'pcvm:cold-start:n9:quality',
        },
        record_repair: {
          pcvNodeId: 'pcvm:n9:record_repair',
          chainNodeId: 'pcvm:cold-start:n9:repair',
        },
      },
    });
    expect(input.context.strategyContext).toMatchObject({
      pcvStageNodeMap: {
        analyze: { pcvNodeId: 'pcvm:n9:analyze' },
      },
      pcvChainNodes: {
        record_repair: { pcvNodeId: 'pcvm:n9:record_repair' },
      },
      pcvStageNodeMapContract: {
        contract: 'PCVBootstrapStageNodeMap',
        contractVersion: 1,
      },
      sharedState: {
        _pcvStageNodeMap: {
          quality_gate: { chainNodeId: 'pcvm:cold-start:n9:quality' },
        },
      },
    });
    expect(input.context.promptContext).toMatchObject({
      pcvStageNodeMap: {
        analyze: { chainNodeId: 'pcvm:cold-start:n9' },
      },
      pcvChainNodes: {},
    });
    expect(input.context.sharedState).toMatchObject({
      _pcvStageNodeMap: {
        analyze: { pcvNodeId: 'pcvm:n9:analyze' },
      },
      _pcvChainNodes: {},
    });
  });
});
