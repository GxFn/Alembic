import { ExplorationTracker } from '@alembic/agent/context';
import type { MemoryCoordinator } from '@alembic/agent/memory';
import { computeAnalystBudget } from '@alembic/agent/prompts';
import {
  createSystemRunContext,
  projectSystemRunContext,
  type SystemRunContext,
} from '@alembic/agent/runtime';
import type { AgentRunInput, SystemRunContextFactory } from '@alembic/agent/service';
import { getDimensionFocusKeywords } from '@alembic/core/dimensions';
import type { KnowledgeRescanExecutionDecision } from '@alembic/core/host-agent-workflows';
import {
  buildEvidenceStarters,
  DIMENSION_CONFIGS_V3,
  getFullDimensionConfig,
} from '@alembic/core/host-agent-workflows';
import type {
  AstSummary,
  DimensionDef,
  GuardAudit,
  SnapshotCallGraphResult,
  SnapshotDependencyGraph,
} from '@alembic/core/project-intelligence';
import type { ProjectScopeSourceIdentityMap } from '../../project-scope/ProjectScopeAnalysis.js';
import {
  type BootstrapFileEntry,
  buildBootstrapDimensionRunInput,
} from './AgentRunInputBuilders.js';
import { buildBootstrapPcvStageNodeContext } from './PcvNodeEvidence.js';
import {
  type BootstrapExistingRecipe,
  type BootstrapRescanContext,
  getBootstrapDimensionExistingRecipes,
  projectBootstrapDimensionRescanContext,
  projectBootstrapExistingRecipesForPrompt,
} from './RescanContext.js';
import type { BootstrapProjectGraphLike } from './RuntimeInitializer.js';

interface DimConfigV3Entry {
  outputType: string;
  allowedKnowledgeTypes: string[];
}

type CreateSystemRunContextOptions = Parameters<typeof createSystemRunContext>[0];

export interface BootstrapDimensionConfig extends Record<string, unknown> {
  id: string;
  label?: string;
  guide?: string;
  focusKeywords?: string[];
  outputType?: string;
  allowedKnowledgeTypes?: string[];
  skillWorthy?: boolean;
  dualOutput?: boolean;
  skillMeta?: unknown;
  knowledgeTypes?: string[];
}

export interface BootstrapDimensionPlan {
  dim: DimensionDef;
  dimConfig: BootstrapDimensionConfig;
  needsCandidates: boolean;
  dimExistingRecipes: BootstrapExistingRecipe[];
  hasExistingRecipes: boolean;
  prescreenDone: boolean;
  rescanExecutionDecision?: KnowledgeRescanExecutionDecision;
}

export interface BootstrapDimensionRuntimeBuildResult {
  analystScopeId: string;
  runInput: AgentRunInput;
}

export function resolveBootstrapDimensionPlan({
  dimId,
  dimensions,
  rescanContext,
}: {
  dimId: string;
  dimensions: DimensionDef[];
  rescanContext: BootstrapRescanContext | null;
}): BootstrapDimensionPlan | null {
  const dim = dimensions.find((candidate) => candidate.id === dimId);
  if (!dim) {
    return null;
  }

  const fullConfig = getFullDimensionConfig(dimId) as BootstrapDimensionConfig | null;
  const v3Config = (DIMENSION_CONFIGS_V3 as Record<string, DimConfigV3Entry | undefined>)[dimId];
  const dimConfig = fullConfig
    ? {
        ...fullConfig,
        focusKeywords: fullConfig.focusKeywords || [],
      }
    : v3Config
      ? ({
          ...v3Config,
          id: dimId,
          label: dim.label,
          guide: dim.guide || '',
          focusKeywords: getDimensionFocusKeywords(dimId, dim.guide || ''),
          skillWorthy: dim.skillWorthy,
          dualOutput: dim.dualOutput,
          skillMeta: dim.skillMeta,
          knowledgeTypes: dim.knowledgeTypes || v3Config.allowedKnowledgeTypes,
        } satisfies BootstrapDimensionConfig)
      : {
          id: dimId,
          label: dim.label,
          guide: dim.guide || '',
          focusKeywords: getDimensionFocusKeywords(dimId, dim.guide || ''),
          outputType: dim.dualOutput ? 'dual' : dim.skillWorthy ? 'skill' : 'candidate',
          allowedKnowledgeTypes: dim.knowledgeTypes || [],
          skillWorthy: dim.skillWorthy,
          dualOutput: dim.dualOutput,
          skillMeta: dim.skillMeta,
          knowledgeTypes: dim.knowledgeTypes || [],
        };
  const v3OutputType = (DIMENSION_CONFIGS_V3 as Record<string, DimConfigV3Entry | undefined>)[dimId]
    ?.outputType;
  const baseNeedsCandidates = Boolean(
    v3OutputType ? v3OutputType !== 'skill' : !dimConfig.skillWorthy || dimConfig.dualOutput
  );
  const dimExistingRecipes = getBootstrapDimensionExistingRecipes({ rescanContext, dimId });
  const rescanExecutionDecision = rescanContext?.executionDecisions[dimId];
  const needsCandidates = rescanExecutionDecision
    ? baseNeedsCandidates &&
      rescanExecutionDecision.mode === 'produce' &&
      rescanExecutionDecision.createBudget > 0
    : baseNeedsCandidates;

  return {
    dim,
    dimConfig,
    needsCandidates,
    dimExistingRecipes,
    hasExistingRecipes: dimExistingRecipes.length > 0,
    prescreenDone: rescanContext?.evolutionPrescreen !== undefined,
    ...(rescanExecutionDecision ? { rescanExecutionDecision } : {}),
  };
}

export function createBootstrapDimensionRuntimeInput({
  dimId,
  plan,
  memoryCoordinator,
  systemRunContextFactory,
  projectInfo,
  primaryLang,
  dimContext,
  sessionStore,
  semanticMemory,
  codeEntityGraphInst,
  projectGraph,
  panoramaResult,
  astProjectSummary,
  guardAudit,
  depGraphData,
  callGraphResult,
  rescanContext,
  targetFileMap,
  globalSubmittedTitles,
  globalSubmittedPatterns,
  globalSubmittedTriggers,
  bootstrapDedup,
  sessionId,
  allFiles,
  projectScopeSourceIdentityMap,
  sessionAbortSignal,
}: {
  dimId: string;
  plan: BootstrapDimensionPlan;
  memoryCoordinator: MemoryCoordinator;
  systemRunContextFactory: SystemRunContextFactory;
  projectInfo: { lang?: string | null; fileCount?: number | null; [key: string]: unknown };
  primaryLang?: string | null;
  dimContext: unknown;
  sessionStore: unknown;
  semanticMemory: unknown;
  codeEntityGraphInst: unknown;
  projectGraph: BootstrapProjectGraphLike | null;
  panoramaResult?: Record<string, unknown> | null;
  astProjectSummary?: AstSummary | null;
  guardAudit?: GuardAudit | null;
  depGraphData?: SnapshotDependencyGraph | null;
  callGraphResult?: SnapshotCallGraphResult | null;
  rescanContext: BootstrapRescanContext | null;
  targetFileMap?: Record<string, unknown> | null;
  globalSubmittedTitles: Set<string>;
  globalSubmittedPatterns: Set<string>;
  globalSubmittedTriggers: Set<string>;
  bootstrapDedup: unknown;
  sessionId: string;
  allFiles: BootstrapFileEntry[] | null;
  projectScopeSourceIdentityMap?: ProjectScopeSourceIdentityMap | null;
  sessionAbortSignal?: AbortSignal | null;
}): BootstrapDimensionRuntimeBuildResult {
  const { dimConfig, needsCandidates, dimExistingRecipes, hasExistingRecipes, prescreenDone } =
    plan;
  const analystScopeId = `${dimId}:analyst`;
  memoryCoordinator.createDimensionScope(analystScopeId);
  const effectiveOutputType = needsCandidates ? 'candidate' : dimConfig.outputType || 'analysis';
  const dimensionMeta = {
    id: dimId,
    outputType: effectiveOutputType,
    allowedKnowledgeTypes: dimConfig.allowedKnowledgeTypes || [],
  };
  const pcvStageNodeContext = buildBootstrapPcvStageNodeContext();
  const contextWindow = systemRunContextFactory.createContextWindow({ isSystem: true });
  const computedBudget = computeAnalystBudget(
    projectInfo.fileCount || 0,
    contextWindow.tokenBudget
  );
  const bootstrapStrategyFields = {
    needsCandidates,
    dimConfig,
    projectInfo,
    dimContext,
    sessionStore,
    semanticMemory,
    codeEntityGraph: codeEntityGraphInst,
    projectGraph,
    panorama: buildPanoramaContext(panoramaResult),
    evidenceStarters: buildEvidenceStarters(plan.dim, {
      astData: astProjectSummary,
      guardAudit,
      depGraphData,
      callGraphResult,
      panoramaResult,
    }),
    rescanContext: projectBootstrapDimensionRescanContext({ rescanContext, dimId }),
    existingRecipes: projectBootstrapExistingRecipesForPrompt(dimExistingRecipes),
    projectOverview: {
      primaryLang: primaryLang || projectInfo.lang || 'unknown',
      fileCount: projectInfo.fileCount || 0,
      modules: Object.keys(targetFileMap || {}),
    },
    ...(projectScopeSourceIdentityMap ? { projectScopeSourceIdentityMap } : {}),
  };
  const systemRunContext = createSystemRunContext({
    memoryCoordinator:
      memoryCoordinator as unknown as CreateSystemRunContextOptions['memoryCoordinator'],
    scopeId: analystScopeId,
    activeContext: memoryCoordinator.getActiveContext(
      analystScopeId
    ) as unknown as CreateSystemRunContextOptions['activeContext'],
    contextWindow,
    tracker: ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      computedBudget
    ) as unknown as CreateSystemRunContextOptions['tracker'],
    source: 'system',
    outputType: effectiveOutputType,
    dimId,
    dimensionId: dimId,
    dimensionLabel: dimConfig.label,
    projectLanguage: primaryLang || projectInfo.lang || null,
    dimensionMeta,
    sharedState: {
      submittedTitles: globalSubmittedTitles,
      submittedPatterns: globalSubmittedPatterns,
      submittedTriggers: globalSubmittedTriggers,
      _bootstrapDedup: bootstrapDedup,
      ...(projectScopeSourceIdentityMap
        ? { _projectScopeSourceIdentityMap: projectScopeSourceIdentityMap }
        : {}),
      _pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      _pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
    },
    extraFields: {
      _computedBudget: computedBudget,
      pcvStageNodeMap: pcvStageNodeContext.pcvStageNodeMap,
      pcvChainNodes: pcvStageNodeContext.pcvChainNodes,
      pcvStageNodeMapContract: {
        contract: pcvStageNodeContext.contract,
        contractVersion: pcvStageNodeContext.contractVersion,
      },
      ...(projectScopeSourceIdentityMap ? { projectScopeSourceIdentityMap } : {}),
    },
  });
  const compactSystemRunContext = compactBootstrapSystemRunContext(systemRunContext);
  // PCVM token-efficiency: runtime references stay in systemRunContext, while
  // bulky project/evidence facts have one owner surface: strategyContext.
  const strategyContext = {
    ...projectSystemRunContext(compactSystemRunContext),
    ...bootstrapStrategyFields,
  };
  return {
    analystScopeId,
    runInput: buildBootstrapDimensionRunInput({
      dimId,
      dimConfig,
      needsCandidates,
      hasExistingRecipes,
      prescreenDone,
      sessionId,
      primaryLang,
      projectLang: projectInfo.lang || null,
      allFiles,
      systemRunContext: compactSystemRunContext as SystemRunContext,
      strategyContext,
      memoryCoordinator,
      projectScopeSourceIdentityMap,
      sessionAbortSignal,
    }),
  };
}

function compactBootstrapSystemRunContext(systemRunContext: SystemRunContext): SystemRunContext {
  return {
    scopeId: systemRunContext.scopeId,
    contextWindow: systemRunContext.contextWindow || null,
    tracker: systemRunContext.tracker || null,
    trace: systemRunContext.trace,
    activeContext: systemRunContext.activeContext,
    memoryCoordinator: systemRunContext.memoryCoordinator,
    sharedState: systemRunContext.sharedState,
    source: systemRunContext.source,
    outputType: systemRunContext.outputType,
    dimId: systemRunContext.dimId,
    dimensionId: systemRunContext.dimensionId,
    dimensionLabel: systemRunContext.dimensionLabel,
    projectLanguage: systemRunContext.projectLanguage,
    submitToolName: systemRunContext.submitToolName,
    pipelineType: systemRunContext.pipelineType,
    _computedBudget: systemRunContext._computedBudget,
    pcvStageNodeMap: systemRunContext.pcvStageNodeMap,
    pcvChainNodes: systemRunContext.pcvChainNodes,
    pcvStageNodeMapContract: systemRunContext.pcvStageNodeMapContract,
  };
}

export function buildPanoramaContext(
  panoramaResult: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!panoramaResult) {
    return null;
  }
  try {
    const modules = panoramaResult.modules as Map<string, Record<string, unknown>> | undefined;
    const layers = panoramaResult.layers as
      | { levels?: Array<{ level: number; name: string; modules: string[] }> }
      | undefined;
    const gaps = (panoramaResult.gaps as Array<{ module: string; suggestedFocus: string[] }>) ?? [];
    const layerNames = (layers?.levels ?? [])
      .map((layer) => `L${layer.level}:${layer.name}`)
      .join(' → ');
    const knownGaps = gaps.slice(0, 5).flatMap((gap) => gap.suggestedFocus ?? []);
    let moduleRole: string | null = null;
    let moduleLayer: number | null = null;
    let moduleCoupling: { fanIn: number; fanOut: number } | null = null;

    if (modules instanceof Map && modules.size > 0) {
      const firstModule = modules.values().next().value;
      if (firstModule) {
        moduleRole =
          (firstModule.refinedRole as string) ?? (firstModule.inferredRole as string) ?? null;
        moduleLayer = (firstModule.layer as number) ?? null;
        moduleCoupling = {
          fanIn: (firstModule.fanIn as number) ?? 0,
          fanOut: (firstModule.fanOut as number) ?? 0,
        };
      }
    }

    return {
      moduleRole,
      moduleLayer,
      moduleCoupling,
      knownGaps: [...new Set(knownGaps)],
      layerContext: layerNames || null,
    };
  } catch {
    return null;
  }
}
