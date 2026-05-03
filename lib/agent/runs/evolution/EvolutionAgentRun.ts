import type { EvolutionCandidateReason } from '../../../service/evolution/RecipeImpactPlanner.js';
import type { ToolCallEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentService } from '../../service/AgentService.js';

export interface EvolutionAuditRecipe {
  id: string;
  title: string;
  trigger: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  auditHint?: {
    relevanceScore: number;
    verdict: string;
    evidence: {
      triggerStillMatches: boolean;
      symbolsAlive: number;
      depsIntact: boolean;
      codeFilesExist: number;
    };
    decayReasons: string[];
  } | null;
  /** diff-based 影响证据（增量 rescan 管线提供） */
  impactEvidence?: {
    reason: EvolutionCandidateReason;
    affectedFiles: string[];
    impactScore: number;
    matchedTokens: string[];
  };
}

export interface EvolutionAuditProjectOverview {
  primaryLang: string;
  fileCount: number;
  modules: string[];
}

export interface EvolutionAuditResult {
  proposed: number;
  deprecated: number;
  skipped: number;
  iterations: number;
  toolCalls: number;
  reply: string;
}

export async function runEvolutionAudit({
  agentService,
  recipes,
  projectOverview,
  dimensionId = 'all',
  dimensionLabel = '全量进化审计',
  proposalSource,
}: {
  agentService: AgentService;
  recipes: EvolutionAuditRecipe[];
  projectOverview: EvolutionAuditProjectOverview;
  dimensionId?: string;
  dimensionLabel?: string;
  /** 传给 evolution-tools 的 source 字段（通过 sharedState 透传） */
  proposalSource?: string;
}): Promise<EvolutionAuditResult> {
  if (recipes.length === 0) {
    return { proposed: 0, deprecated: 0, skipped: 0, toolCalls: 0, iterations: 0, reply: '' };
  }

  const sharedState: Record<string, unknown> = {};
  if (proposalSource) {
    sharedState.evolutionProposalSource = proposalSource;
  }

  const strategyContext = {
    existingRecipes: recipes,
    dimensionId,
    dimensionLabel,
    projectOverview,
    sharedState,
  };
  const result = await agentService.run({
    profile: { id: 'evolution-audit' },
    params: { recipes, projectOverview, dimensionId, dimensionLabel },
    message: {
      role: 'internal',
      content: `请验证 ${recipes.length} 条 Recipe 的源码真实性并提交进化决策。`,
      metadata: { task: 'evolution-audit', dimensionId, dimensionLabel },
    },
    context: {
      source: 'system-workflow',
      runtimeSource: 'system',
      strategyContext,
    },
    presentation: { responseShape: 'system-task-result' },
  });

  return projectEvolutionAuditResult({
    reply: result.reply,
    toolCalls: result.toolCalls,
    iterations: result.usage.iterations,
  });
}

export function projectEvolutionAuditResult({
  reply,
  toolCalls,
  iterations,
}: {
  reply: string;
  toolCalls: ToolCallEntry[];
  iterations: number;
}): EvolutionAuditResult {
  return {
    proposed: countManageOps(toolCalls, 'evolve'),
    deprecated: countManageOps(toolCalls, 'deprecate'),
    skipped: countManageOps(toolCalls, 'skip_evolution'),
    iterations,
    toolCalls: toolCalls.length,
    reply: reply || '',
  };
}

/** V2: knowledge.manage(operation: X) 统计；V1 compat: 独立工具名 fallback */
function countManageOps(toolCalls: ToolCallEntry[], operation: string) {
  let count = 0;
  for (const tc of toolCalls) {
    const tool = tc.tool || tc.name;
    if (tool === 'knowledge') {
      const params = (tc.args?.params as Record<string, unknown>) || tc.args || {};
      if (params.operation === operation) {
        count++;
      }
    }
    // V1 compat
    const v1Map: Record<string, string> = {
      evolve: 'propose_evolution',
      deprecate: 'confirm_deprecation',
      skip_evolution: 'skip_evolution',
    };
    if (tool === v1Map[operation]) {
      count++;
    }
  }
  return count;
}
