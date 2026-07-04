import { MemoryCoordinator } from '@alembic/agent/memory';
import type { SystemRunContextFactory } from '@alembic/agent/service';
import type { KnowledgeRescanExecutionDecision } from '@alembic/core/host-agent-workflows';
import { describe, expect, test, vi } from 'vitest';
import { buildProjectScopeSourceIdentityMap } from '../../lib/project-scope/ProjectScopeAnalysis.js';
import { prepareGenerateRescanState } from '../../lib/recipe-pipeline/generate/dedup/GenerateDedupSeeder.js';
import { buildGenerateDimensionRunInput } from '../../lib/recipe-pipeline/generate/execution/AgentRunInputBuilders.js';
import {
  buildPanoramaContext,
  createGenerateDimensionRuntimeInput,
  resolveGenerateDimensionPlan,
} from '../../lib/recipe-pipeline/generate/execution/DimensionRuntimeBuilder.js';

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
    const skillPlan = resolveGenerateDimensionPlan({
      dimId: 'custom-skill-dim',
      dimensions,
      rescanContext: null,
    });
    const dualPlan = resolveGenerateDimensionPlan({
      dimId: 'custom-dual-dim',
      dimensions,
      rescanContext: null,
    });

    expect(skillPlan?.dimConfig.outputType).toBe('skill');
    expect(skillPlan?.needsCandidates).toBe(false);
    expect(dualPlan?.dimConfig.outputType).toBe('dual');
    expect(dualPlan?.needsCandidates).toBe(true);
    expect(
      resolveGenerateDimensionPlan({ dimId: 'missing', dimensions, rescanContext: null })
    ).toBeNull();
  });

  test('carries rescan state into dimension plan and runtime input', () => {
    const {
      rescanContext,
      globalSubmittedTitles,
      globalSubmittedPatterns,
      globalSubmittedTriggers,
    } = prepareGenerateRescanState({
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
    const plan = resolveGenerateDimensionPlan({
      dimId: 'custom-dual-dim',
      dimensions,
      rescanContext,
    });
    expect(plan).not.toBeNull();
    if (!plan) {
      throw new Error('expected custom-dual-dim plan');
    }
    expect(plan.hasExistingRecipes).toBe(true);
    expect(plan.prescreenDone).toBe(true);

    const memoryCoordinator = new MemoryCoordinator({ mode: 'bootstrap' });
    const projectScopeSourceIdentityMap = buildProjectScopeSourceIdentityMap([
      {
        absolutePath: '/workspace/AlembicCore/lib/index.ts',
        folderDisplayName: 'AlembicCore',
        folderId: 'folder-core',
        folderPath: '/workspace/AlembicCore',
        folderRelativeRoot: 'AlembicCore',
        projectScopeId: 'scope-a',
        qualifiedPath: 'AlembicCore/lib/index.ts',
        relativePath: 'lib/index.ts',
      },
    ]);
    const result = createGenerateDimensionRuntimeInput({
      dimId: 'custom-dual-dim',
      plan,
      memoryCoordinator,
      systemRunContextFactory: createContextFactory(),
      projectInfo: { name: 'repo', lang: 'typescript', fileCount: 10 },
      primaryLang: 'typescript',
      dimContext: {},
      sessionStore: {},
      semanticMemory: {},
      projectGraph: { getOverview: () => ({ totalClasses: 0, totalProtocols: 0 }) },
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
      projectScopeSourceIdentityMap,
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
    expect(strategyContext.outputType).toBe('candidate');
    expect(strategyContext.needsCandidates).toBe(true);
    expect(systemRunContext.sharedState).toMatchObject({
      submittedTitles: globalSubmittedTitles,
      submittedPatterns: globalSubmittedPatterns,
      submittedTriggers: globalSubmittedTriggers,
      _pcvStageNodeMap: {
        analyze: {
          pcvNodeId: 'pcvm:n9:analyze',
          chainNodeId: 'pcvm:cold-start:n9',
        },
      },
      _pcvChainNodes: {
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
    expect(strategyContext).toMatchObject({
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
    });
    expect(result.runInput.context.promptContext).toMatchObject({
      pcvStageNodeMap: {
        quality_gate: { chainNodeId: 'pcvm:cold-start:n9:quality' },
      },
      pcvChainNodes: {},
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
    expect(strategyContext.projectScopeSourceIdentityMap).toMatchObject({
      contract: 'ProjectScopeSourceIdentityMap',
      entries: [{ qualifiedPath: 'AlembicCore/lib/index.ts' }],
      preferredRef: 'qualifiedPath',
    });
    expect(systemRunContext.sharedState).toMatchObject({
      _projectScopeSourceIdentityMap: {
        entries: [{ qualifiedPath: 'AlembicCore/lib/index.ts' }],
      },
    });
    expect(strategyContext.projectGraph).toBeTruthy();
    expect(systemRunContext).not.toHaveProperty('projectGraph');
    expect(systemRunContext).not.toHaveProperty('evidenceStarters');
    expect(systemRunContext).not.toHaveProperty('existingRecipes');
    expect(systemRunContext).not.toHaveProperty('projectOverview');
  });

  test('carries ProjectScope source identity map through dimension run input surfaces', () => {
    const memoryCoordinator = new MemoryCoordinator({ mode: 'bootstrap' });
    const projectScopeSourceIdentityMap = buildProjectScopeSourceIdentityMap([
      {
        absolutePath: '/workspace/AlembicCore/lib/index.ts',
        folderDisplayName: 'AlembicCore',
        folderId: 'folder-core',
        folderPath: '/workspace/AlembicCore',
        folderRelativeRoot: 'AlembicCore',
        projectScopeId: 'scope-a',
        qualifiedPath: 'AlembicCore/lib/index.ts',
        relativePath: 'lib/index.ts',
      },
    ]);

    const runInput = buildGenerateDimensionRunInput({
      dimId: 'custom-dual-dim',
      dimConfig: { label: 'Custom Dual' },
      needsCandidates: true,
      hasExistingRecipes: false,
      prescreenDone: false,
      sessionId: 'session-1',
      primaryLang: 'typescript',
      projectLang: 'typescript',
      allFiles: [],
      systemRunContext: {
        contextWindow: null,
        memoryCoordinator,
        scopeId: 'custom-dual-dim:analyst',
        sharedState: {},
        source: 'system',
        trace: null,
      } as never,
      strategyContext: {},
      memoryCoordinator,
      projectScopeSourceIdentityMap,
    });

    expect(runInput.context.strategyContext).toMatchObject({
      projectScopeSourceIdentityMap: { sourceCount: 1 },
    });
    expect(runInput.context.promptContext).toMatchObject({
      projectScopeSourceIdentityMap: { sourceCount: 1 },
    });
    expect(runInput.context.sharedState).toMatchObject({
      _projectScopeSourceIdentityMap: { sourceCount: 1 },
    });
    expect(runInput.message.metadata?.context).toMatchObject({
      projectScopeSourceIdentityMap: { sourceCount: 1 },
    });
  });

  test('turns verify-only rescan decisions into analyze-only dimension runs', () => {
    const decision: KnowledgeRescanExecutionDecision = {
      dimensionId: 'custom-dual-dim',
      dimension: dimensions[1],
      mode: 'verify-only',
      createBudget: 0,
      existingCount: 5,
      gap: 0,
      existingRecipes: [],
      decayingRecipes: [],
      reasons: [{ kind: 'file-change', changedFiles: ['src/api.ts'] }],
      shouldExecute: true,
    };
    const {
      rescanContext,
      globalSubmittedTitles,
      globalSubmittedPatterns,
      globalSubmittedTriggers,
    } = prepareGenerateRescanState({
      existingRecipes: [
        {
          id: 'recipe-1',
          title: 'Healthy Recipe',
          trigger: 'healthy_trigger',
          knowledgeType: 'custom-dual-dim',
        },
      ],
      evolutionPrescreen: { done: true },
      executionDecisions: [decision],
    });
    const plan = resolveGenerateDimensionPlan({
      dimId: 'custom-dual-dim',
      dimensions,
      rescanContext,
    });
    expect(plan).not.toBeNull();
    if (!plan) {
      throw new Error('expected custom-dual-dim plan');
    }
    expect(plan.needsCandidates).toBe(false);
    expect(plan.rescanExecutionDecision).toBe(decision);

    const memoryCoordinator = new MemoryCoordinator({ mode: 'bootstrap' });
    const result = createGenerateDimensionRuntimeInput({
      dimId: 'custom-dual-dim',
      plan,
      memoryCoordinator,
      systemRunContextFactory: createContextFactory(),
      projectInfo: { name: 'repo', lang: 'typescript', fileCount: 10 },
      primaryLang: 'typescript',
      dimContext: {},
      sessionStore: {},
      semanticMemory: {},
      projectGraph: { getOverview: () => ({ totalClasses: 0, totalProtocols: 0 }) },
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

    expect(result.runInput.params).toMatchObject({
      dimId: 'custom-dual-dim',
      needsCandidates: false,
    });
    expect(strategyContext.outputType).toBe('dual');
    expect(strategyContext.needsCandidates).toBe(false);
    expect(strategyContext.rescanContext).toMatchObject({
      gap: 0,
      createBudget: 0,
      executionMode: 'verify-only',
      existing: 5,
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
