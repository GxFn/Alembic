import { describe, expect, test, vi } from 'vitest';
import { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import type { SystemRunContextFactory } from '#agent/service/index.js';
import {
  buildPanoramaContext,
  createBootstrapDimensionRuntimeInput,
  resolveBootstrapDimensionPlan,
} from '#workflows/capabilities/execution/internal-agent/agent-runs/BootstrapDimensionRuntimeBuilder.js';
import { prepareBootstrapRescanState } from '#workflows/capabilities/execution/internal-agent/context/BootstrapRescanState.js';

const dimensions = [
  {
    id: 'custom-skill-dim',
    label: 'Custom Skill',
    guide: 'Focus on custom skill behavior',
    skillWorthy: true,
    dualOutput: false,
    knowledgeTypes: ['custom-skill-dim'],
  },
  {
    id: 'custom-dual-dim',
    label: 'Custom Dual',
    guide: 'Focus on dual output behavior',
    skillWorthy: true,
    dualOutput: true,
    knowledgeTypes: ['custom-dual-dim'],
  },
];

function createContextFactory() {
  return {
    createContextWindow: vi.fn(() => ({
      resetForNewStage: vi.fn(),
      tokenCount: 0,
    })),
  } as unknown as SystemRunContextFactory;
}

describe('bootstrap dimension runtime builder', () => {
  test('resolves fallback dimension config and candidate requirements', () => {
    const skillPlan = resolveBootstrapDimensionPlan({
      dimId: 'custom-skill-dim',
      dimensions,
      rescanContext: null,
    });
    const dualPlan = resolveBootstrapDimensionPlan({
      dimId: 'custom-dual-dim',
      dimensions,
      rescanContext: null,
    });

    expect(skillPlan?.dimConfig.outputType).toBe('skill');
    expect(skillPlan?.needsCandidates).toBe(false);
    expect(dualPlan?.dimConfig.outputType).toBe('dual');
    expect(dualPlan?.needsCandidates).toBe(true);
    expect(
      resolveBootstrapDimensionPlan({ dimId: 'missing', dimensions, rescanContext: null })
    ).toBeNull();
  });

  test('carries rescan state into dimension plan and runtime input', () => {
    const {
      rescanContext,
      globalSubmittedTitles,
      globalSubmittedPatterns,
      globalSubmittedTriggers,
    } = prepareBootstrapRescanState({
      existingRecipes: [
        {
          id: 'recipe-1',
          title: 'Healthy Recipe',
          trigger: 'healthy_trigger',
          knowledgeType: 'custom-dual-dim',
          auditScore: 0.8,
        },
        {
          id: 'recipe-2',
          title: 'Decaying Recipe',
          trigger: 'decaying_trigger',
          knowledgeType: 'custom-dual-dim',
          status: 'decaying',
          decayReason: 'stale',
        },
      ],
      evolutionPrescreen: { done: true },
    });
    const plan = resolveBootstrapDimensionPlan({
      dimId: 'custom-dual-dim',
      dimensions,
      rescanContext,
    });
    expect(plan?.hasExistingRecipes).toBe(true);
    expect(plan?.prescreenDone).toBe(true);

    const memoryCoordinator = new MemoryCoordinator({ mode: 'bootstrap' });
    const result = createBootstrapDimensionRuntimeInput({
      dimId: 'custom-dual-dim',
      plan: plan!,
      memoryCoordinator,
      systemRunContextFactory: createContextFactory(),
      projectInfo: { name: 'repo', lang: 'typescript', fileCount: 10 },
      primaryLang: 'typescript',
      dimContext: {},
      sessionStore: {},
      semanticMemory: {},
      codeEntityGraphInst: {},
      panoramaResult: null,
      astProjectSummary: null,
      guardAudit: null,
      depGraphData: null,
      callGraphResult: null,
      rescanContext,
      targetFileMap: { src: [] },
      globalSubmittedTitles,
      globalSubmittedPatterns,
      globalSubmittedTriggers,
      bootstrapDedup: {},
      sessionId: 'session-1',
      allFiles: [],
      sessionAbortSignal: null,
    });
    const strategyContext = result.runInput.context?.strategyContext as Record<string, unknown>;
    const systemRunContext = result.runInput.context?.systemRunContext as Record<string, unknown>;

    expect(result.analystScopeId).toBe('custom-dual-dim:analyst');
    expect(result.runInput.params).toMatchObject({
      dimId: 'custom-dual-dim',
      needsCandidates: true,
      hasExistingRecipes: true,
      prescreenDone: true,
    });
    expect(systemRunContext.sharedState).toMatchObject({
      submittedTitles: globalSubmittedTitles,
      submittedPatterns: globalSubmittedPatterns,
      submittedTriggers: globalSubmittedTriggers,
    });
    expect(strategyContext.rescanContext).toMatchObject({ gap: 4, existing: 1 });
    expect(strategyContext.existingRecipes).toEqual([
      expect.objectContaining({
        id: 'recipe-1',
        auditHint: expect.objectContaining({ verdict: 'watch' }),
      }),
      expect.objectContaining({ id: 'recipe-2', auditHint: null }),
    ]);
    expect(strategyContext.projectOverview).toEqual({
      primaryLang: 'typescript',
      fileCount: 10,
      modules: ['src'],
    });
  });

  test('builds compact panorama context defensively', () => {
    expect(
      buildPanoramaContext({
        modules: new Map([['src/api.ts', { refinedRole: 'api', layer: 2, fanIn: 3, fanOut: 1 }]]),
        layers: { levels: [{ level: 1, name: 'domain', modules: ['src/domain.ts'] }] },
        gaps: [
          { module: 'src/api.ts', suggestedFocus: ['contracts', 'contracts'] },
          { module: 'src/ui.ts', suggestedFocus: ['state'] },
        ],
      })
    ).toEqual({
      moduleRole: 'api',
      moduleLayer: 2,
      moduleCoupling: { fanIn: 3, fanOut: 1 },
      knownGaps: ['contracts', 'state'],
      layerContext: 'L1:domain',
    });
    expect(buildPanoramaContext(null)).toBeNull();
  });
});
