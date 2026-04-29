import { ExplorationTracker } from '#agent/context/ExplorationTracker.js';
import type { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import { computeAnalystBudget } from '#agent/prompts/insight-analyst.js';
import {
  createSystemRunContext,
  projectSystemRunContext,
} from '#agent/runtime/SystemRunContext.js';
import type { AgentRunInput, SystemRunContextFactory } from '#agent/service/index.js';
import { getDimensionFocusKeywords } from '#domain/dimension/DimensionSop.js';
import type {
  AstSummary,
  CallGraphResult,
  DependencyGraph,
  DimensionDef,
  GuardAudit,
} from '#types/project-snapshot.js';
import { buildEvidenceStarters } from '#workflows/capabilities/execution/external-agent/mission-briefing/EvidenceStarterBuilder.js';
import {
  type BootstrapFileEntry,
  buildBootstrapDimensionRunInput,
} from '#workflows/capabilities/execution/internal-agent/agent-runs/BootstrapDimensionInputBuilder.js';
import {
  type BootstrapExistingRecipe,
  type BootstrapRescanContext,
  getBootstrapDimensionExistingRecipes,
  projectBootstrapDimensionRescanContext,
  projectBootstrapExistingRecipesForPrompt,
} from '#workflows/capabilities/execution/internal-agent/context/BootstrapRescanState.js';
import type {
  BootstrapTerminalMode,
  BootstrapTerminalToolset,
} from '#workflows/capabilities/planning/dimensions/BootstrapTerminalToolset.js';
import {
  DIMENSION_CONFIGS_V3,
  getFullDimensionConfig,
} from '#workflows/capabilities/planning/dimensions/bootstrapDimensionConfigs.js';

interface DimConfigV3Entry {
  outputType: string;
  allowedKnowledgeTypes: string[];
}

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
  const needsCandidates = Boolean(
    v3OutputType ? v3OutputType !== 'skill' : !dimConfig.skillWorthy || dimConfig.dualOutput
  );
  const dimExistingRecipes = getBootstrapDimensionExistingRecipes({ rescanContext, dimId });

  return {
    dim,
    dimConfig,
    needsCandidates,
    dimExistingRecipes,
    hasExistingRecipes: dimExistingRecipes.length > 0,
    prescreenDone: rescanContext?.evolutionPrescreen !== undefined,
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
  sessionAbortSignal,
  terminalTest,
  terminalToolset,
  allowedTerminalModes,
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
  panoramaResult?: Record<string, unknown> | null;
  astProjectSummary?: AstSummary | null;
  guardAudit?: GuardAudit | null;
  depGraphData?: DependencyGraph | null;
  callGraphResult?: CallGraphResult | null;
  rescanContext: BootstrapRescanContext | null;
  targetFileMap?: Record<string, unknown> | null;
  globalSubmittedTitles: Set<string>;
  globalSubmittedPatterns: Set<string>;
  globalSubmittedTriggers: Set<string>;
  bootstrapDedup: unknown;
  sessionId: string;
  allFiles: BootstrapFileEntry[] | null;
  sessionAbortSignal?: AbortSignal | null;
  terminalTest?: boolean;
  terminalToolset?: BootstrapTerminalToolset;
  allowedTerminalModes?: BootstrapTerminalMode[];
}): BootstrapDimensionRuntimeBuildResult {
  const { dimConfig, needsCandidates, dimExistingRecipes, hasExistingRecipes, prescreenDone } =
    plan;
  const analystScopeId = `${dimId}:analyst`;
  memoryCoordinator.createDimensionScope(analystScopeId);
  const dimensionMeta = {
    id: dimId,
    outputType: dimConfig.outputType || 'candidate',
    allowedKnowledgeTypes: dimConfig.allowedKnowledgeTypes || [],
  };
  const systemRunContext = createSystemRunContext({
    memoryCoordinator,
    scopeId: analystScopeId,
    activeContext: memoryCoordinator.getActiveContext(analystScopeId),
    contextWindow: systemRunContextFactory.createContextWindow({ isSystem: true }),
    tracker: ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      computeAnalystBudget(projectInfo.fileCount || 0)
    ),
    source: 'system',
    outputType: dimConfig.outputType || 'analysis',
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
    },
    extraFields: {
      dimConfig,
      projectInfo,
      dimContext,
      sessionStore,
      semanticMemory,
      codeEntityGraph: codeEntityGraphInst,
      projectGraph: null,
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
      terminalTest,
      terminalToolset,
      allowedTerminalModes,
      projectOverview: {
        primaryLang: primaryLang || projectInfo.lang || 'unknown',
        fileCount: projectInfo.fileCount || 0,
        modules: Object.keys(targetFileMap || {}),
      },
    },
  });
  const strategyContext = projectSystemRunContext(systemRunContext);
  strategyContext.terminalTest = terminalTest === true;
  strategyContext.terminalToolset = terminalToolset || 'baseline';
  strategyContext.allowedTerminalModes = allowedTerminalModes || [];
  return {
    analystScopeId,
    runInput: buildBootstrapDimensionRunInput({
      dimId,
      dimConfig,
      needsCandidates,
      hasExistingRecipes,
      prescreenDone,
      terminalTest,
      terminalToolset,
      allowedTerminalModes,
      sessionId,
      primaryLang,
      projectLang: projectInfo.lang || null,
      allFiles,
      systemRunContext,
      strategyContext,
      memoryCoordinator,
      sessionAbortSignal,
    }),
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
