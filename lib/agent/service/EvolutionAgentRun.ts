import type { ToolCallEntry } from '../AgentRuntimeTypes.js';
import type { AgentService } from './AgentService.js';

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
}: {
  agentService: AgentService;
  recipes: EvolutionAuditRecipe[];
  projectOverview: EvolutionAuditProjectOverview;
  dimensionId?: string;
  dimensionLabel?: string;
}): Promise<EvolutionAuditResult> {
  if (recipes.length === 0) {
    return { proposed: 0, deprecated: 0, skipped: 0, toolCalls: 0, iterations: 0, reply: '' };
  }

  const strategyContext = {
    existingRecipes: recipes,
    dimensionId,
    dimensionLabel,
    projectOverview,
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
    proposed: countToolCalls(toolCalls, 'propose_evolution'),
    deprecated: countToolCalls(toolCalls, 'confirm_deprecation'),
    skipped: countToolCalls(toolCalls, 'skip_evolution'),
    iterations,
    toolCalls: toolCalls.length,
    reply: reply || '',
  };
}

function countToolCalls(toolCalls: ToolCallEntry[], toolName: string) {
  return toolCalls.filter((tc) => (tc.tool || tc.name) === toolName).length;
}
